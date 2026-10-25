// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IGradewireRegistry {
    function slash(address provider, bytes32 jobId, address buyer, address[] calldata verifiers) external;
}

/// @title GradingServiceManager: AVS-pattern verification tasks (EigenLayer-ready, standalone here).
/// @notice The coordinator opens a task for a sampled grading job. Allowlisted operators re-run
///         the job and respond with an EIP-712 signature over (taskId, matched, operatorHash).
///         Because grading is deterministic, `matched` is checked on-chain against the provider's
///         hash. At QUORUM agreeing responses the verdict is posted; a failed verdict slashes the
///         provider's bond in the same transaction and refunds the buyer.
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
    }

    event OperatorSet(address indexed operator, bool allowed);
    event NewTaskCreated(uint32 indexed taskId, bytes32 indexed jobId, address indexed provider, address buyer, bytes32 providerResultHash);
    event TaskResponded(uint32 indexed taskId, address indexed operator, bool matched, bytes32 operatorHash);
    event VerdictPosted(uint32 indexed taskId, bytes32 indexed jobId, address indexed provider, bool pass);

    bytes32 public constant RESPONSE_TYPEHASH = keccak256("TaskResponse(uint32 taskId,bool matched,bytes32 operatorHash)");
    uint8 public immutable QUORUM;

    address public owner;
    IGradewireRegistry public immutable registry;
    mapping(address => bool) public isOperator;
    uint32 public taskCount;
    mapping(uint32 => Task) public tasks;
    mapping(uint32 => mapping(address => bool)) public hasResponded;
    mapping(uint32 => address[]) private _mismatchers;
    bytes32 private immutable _domainSeparator;

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(address registry_, address[] memory operators, uint8 quorum) {
        require(quorum > 0 && quorum <= operators.length, "bad quorum");
        owner = msg.sender;
        registry = IGradewireRegistry(registry_);
        QUORUM = quorum;
        for (uint256 i = 0; i < operators.length; i++) {
            isOperator[operators[i]] = true;
            emit OperatorSet(operators[i], true);
        }
        _domainSeparator = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("GradingServiceManager"), keccak256("1"), block.chainid, address(this)
        ));
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        isOperator[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    function createVerificationTask(bytes32 jobId, address provider, address buyer, bytes32 providerResultHash) external onlyOwner returns (uint32 taskId) {
        taskId = ++taskCount;
        tasks[taskId] = Task(jobId, provider, buyer, providerResultHash, 0, 0, false, false);
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
            if (t.matched >= QUORUM) _finalize(taskId, t, true);
        } else {
            t.mismatched++;
            _mismatchers[taskId].push(operator);
            if (t.mismatched >= QUORUM) _finalize(taskId, t, false);
        }
    }

    function _finalize(uint32 taskId, Task storage t, bool pass) internal {
        t.finalized = true;
        t.pass = pass;
        emit VerdictPosted(taskId, t.jobId, t.provider, pass);
        if (!pass) registry.slash(t.provider, t.jobId, t.buyer, _mismatchers[taskId]);
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
