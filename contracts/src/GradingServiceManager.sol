// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IGradewireRegistry {
    function slash(address provider, bytes32 jobId, address buyer, address[] calldata verifiers) external;
    function lockBond(address provider, bool open) external;
}

/// @title GradingServiceManager: AVS-pattern verification tasks (EigenLayer-ready, standalone here).
/// @notice The coordinator opens a task for a sampled grading job, presenting the provider's own
///         EIP-712 signature over (jobId, resultHash) so nobody can frame a provider with a hash
///         it never signed. Allowlisted operators re-run the job and respond with an EIP-712
///         signature over (taskId, matched, operatorHash); `matched` is checked on-chain against
///         the provider's hash. A verdict is posted when QUORUM operators agree: a pass needs
///         QUORUM matches, a fail needs QUORUM operators converging on the SAME other hash
///         (operators that disagree with each other prove non-determinism, not fraud, and the
///         task ends inconclusive with no slash). A fail slashes the provider's bond in the same
///         transaction; if the money leg reverts the verdict still stands and the slash can be retried.
contract GradingServiceManager {
    struct Task {
        bytes32 jobId;
        address provider;
        address buyer;
        bytes32 providerResultHash;
        uint8 matched;
        uint8 mismatched;
        bool finalized;
        bool pass;
        bool inconclusive;
        bytes32 consensusHash;
        uint8 consensusCount;
    }

    event OperatorSet(address indexed operator, bool allowed);
    event NewTaskCreated(uint32 indexed taskId, bytes32 indexed jobId, address indexed provider, address buyer, bytes32 providerResultHash);
    event TaskResponded(uint32 indexed taskId, address indexed operator, bool matched, bytes32 operatorHash);
    event VerdictPosted(uint32 indexed taskId, bytes32 indexed jobId, address indexed provider, bool pass);
    event TaskInconclusive(uint32 indexed taskId, bytes32 indexed jobId, address indexed provider);
    event SlashFailed(uint32 indexed taskId, address indexed provider, bytes reason);

    bytes32 public constant RESPONSE_TYPEHASH = keccak256("TaskResponse(uint32 taskId,bool matched,bytes32 operatorHash)");
    bytes32 public constant RESULT_TYPEHASH = keccak256("GradeResult(bytes32 jobId,bytes32 resultHash)");
    uint8 public immutable QUORUM;

    address public owner;
    IGradewireRegistry public immutable registry;
    mapping(address => bool) public isOperator;
    uint256 public operatorCount;
    uint32 public taskCount;
    mapping(uint32 => Task) public tasks;
    mapping(uint32 => mapping(address => bool)) public hasResponded;
    mapping(uint32 => bool) public pendingSlash;
    mapping(uint32 => address[]) private _mismatchers;
    bytes32 private immutable _domainSeparator;

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(address registry_, address[] memory operators, uint8 quorum) {
        require(registry_ != address(0), "zero registry");
        owner = msg.sender;
        registry = IGradewireRegistry(registry_);
        QUORUM = quorum;
        for (uint256 i = 0; i < operators.length; i++) {
            require(operators[i] != address(0) && !isOperator[operators[i]], "bad operator");
            isOperator[operators[i]] = true;
            operatorCount++;
            emit OperatorSet(operators[i], true);
        }
        _requireMajorityQuorum();
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        require(operator != address(0), "zero address");
        if (allowed && !isOperator[operator]) operatorCount++;
        if (!allowed && isOperator[operator]) operatorCount--;
        isOperator[operator] = allowed;
        _requireMajorityQuorum();
        emit OperatorSet(operator, allowed);
    }

    /// @param providerSignature the provider's EIP-712 signature over GradeResult(jobId, providerResultHash),
    ///        which the provider also gave the buyer with the grade.
    function createVerificationTask(bytes32 jobId, address provider, address buyer, bytes32 providerResultHash, bytes calldata providerSignature)
        external onlyOwner returns (uint32 taskId)
    {
        require(provider != address(0) && buyer != address(0), "zero address");
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator,
            keccak256(abi.encode(RESULT_TYPEHASH, jobId, providerResultHash))));
        require(_recover(digest, providerSignature) == provider, "provider did not sign this result");
        taskId = ++taskCount;
        Task storage t = tasks[taskId];
        t.jobId = jobId; t.provider = provider; t.buyer = buyer; t.providerResultHash = providerResultHash;
        registry.lockBond(provider, true);
        emit NewTaskCreated(taskId, jobId, provider, buyer, providerResultHash);
    }

    /// @param signature EIP-712 signature by an operator over TaskResponse(taskId, matched, operatorHash).
    ///        Anyone may submit it, so operators can relay through the coordinator or send themselves.
    function respondToTask(uint32 taskId, bool matched, bytes32 operatorHash, bytes calldata signature) external {
        Task storage t = tasks[taskId];
        require(t.provider != address(0), "no task");
        require(!t.finalized, "finalized");
        // Grading is deterministic: a claimed match must be the provider's exact hash.
        require(matched == (operatorHash == t.providerResultHash), "inconsistent response");
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator,
            keccak256(abi.encode(RESPONSE_TYPEHASH, taskId, matched, operatorHash))));
        address operator = _recover(digest, signature);
        require(isOperator[operator], "not operator");
        require(!hasResponded[taskId][operator], "duplicate");
        hasResponded[taskId][operator] = true;
        emit TaskResponded(taskId, operator, matched, operatorHash);
        if (matched) {
            t.matched++;
            if (t.matched >= QUORUM) return _finalize(taskId, t, true);
        } else {
            t.mismatched++;
            _mismatchers[taskId].push(operator);
            // Fraud needs QUORUM operators converging on the same alternative hash.
            if (t.consensusCount == 0 || operatorHash == t.consensusHash) { t.consensusHash = operatorHash; t.consensusCount++; }
            if (t.consensusCount >= QUORUM) return _finalize(taskId, t, false);
        }
        if (uint256(t.matched) + uint256(t.mismatched) >= operatorCount) {
            // Everyone answered and neither side reached quorum: non-determinism, not fraud.
            t.finalized = true;
            t.inconclusive = true;
            registry.lockBond(t.provider, false);
            emit TaskInconclusive(taskId, t.jobId, t.provider);
        }
    }

    /// @notice Anyone may retry a slash whose first attempt reverted (for example a token transfer
    ///         refused at that moment); the verdict itself was already posted.
    function retrySlash(uint32 taskId) external {
        Task storage t = tasks[taskId];
        require(t.finalized && !t.pass && !t.inconclusive && pendingSlash[taskId], "nothing to retry");
        pendingSlash[taskId] = false;
        registry.slash(t.provider, t.jobId, t.buyer, _mismatchers[taskId]);
    }

    function _finalize(uint32 taskId, Task storage t, bool pass) internal {
        t.finalized = true;
        t.pass = pass;
        registry.lockBond(t.provider, false);
        emit VerdictPosted(taskId, t.jobId, t.provider, pass);
        if (!pass) {
            // Never let the money leg block the verdict.
            try registry.slash(t.provider, t.jobId, t.buyer, _mismatchers[taskId]) {}
            catch (bytes memory reason) { pendingSlash[taskId] = true; emit SlashFailed(taskId, t.provider, reason); }
        }
    }

    function _requireMajorityQuorum() internal view {
        require(operatorCount >= QUORUM && uint256(QUORUM) * 2 > operatorCount, "quorum must be a majority");
    }

    function domainSeparator() external view returns (bytes32) { return _domainSeparator; }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "bad sig");
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "bad s");
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "bad signer");
        return signer;
    }
}
