// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title GradewireRegistry: provider registry, RLUSD bonds and slashing.
/// @notice A failed verification slashes the provider's whole bond: 50% refunds the buyer,
///         30% rewards the verifiers that caught it, 20% goes to the treasury. Withdrawals
///         need an approver signature (a hardware wallet in production) so a stolen node key
///         cannot drain a bond, and are refused while a verification task is open.
///         The service manager is set once: the owner key cannot redirect slashing.
contract GradewireRegistry {
    enum Status { None, Registered, Active, Suspended }

    struct Provider {
        string endpoint;
        Status status;
        uint256 bond;
        bytes32 benchmarkHash;
    }

    event ProviderRegistered(address indexed provider, string endpoint);
    event ProviderAttested(address indexed provider, bytes32 benchmarkHash);
    event Bonded(address indexed provider, uint256 amount, uint256 total);
    event BondWithdrawn(address indexed provider, uint256 amount);
    event Slashed(address indexed provider, bytes32 indexed jobId, address indexed buyer, uint256 refund, uint256 verifierReward, uint256 treasuryShare);

    bytes32 public constant WITHDRAW_TYPEHASH = keccak256("WithdrawApproval(address provider,uint256 amount,uint256 nonce,uint256 deadline)");
    uint256 public constant REFUND_BPS = 5000;
    uint256 public constant VERIFIER_BPS = 3000;

    IERC20 public immutable rlusd;
    address public owner;
    address public serviceManager;
    address public approver;
    address public treasury;
    uint256 public minBond;
    mapping(address => Provider) public providers;
    mapping(address => uint256) public withdrawNonce;
    mapping(address => uint256) public openTasks;
    bytes32 private immutable _domainSeparator;

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier onlyServiceManager() { require(msg.sender == serviceManager, "not service manager"); _; }

    constructor(address rlusd_, address approver_, address treasury_, uint256 minBond_) {
        require(rlusd_ != address(0) && approver_ != address(0) && treasury_ != address(0), "zero address");
        rlusd = IERC20(rlusd_);
        owner = msg.sender;
        approver = approver_;
        treasury = treasury_;
        minBond = minBond_;
        _domainSeparator = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("GradewireRegistry"), keccak256("1"), block.chainid, address(this)
        ));
    }

    /// @notice One-shot: the contract that may slash cannot be changed afterwards.
    function setServiceManager(address sm) external onlyOwner {
        require(serviceManager == address(0), "already set");
        require(sm != address(0), "zero address");
        serviceManager = sm;
    }
    function setApprover(address a) external onlyOwner { require(a != address(0), "zero address"); approver = a; }
    function setTreasury(address t) external onlyOwner { require(t != address(0), "zero address"); treasury = t; }
    function setMinBond(uint256 m) external onlyOwner { minBond = m; }

    function register(string calldata endpoint) external {
        Provider storage p = providers[msg.sender];
        require(p.status != Status.Suspended, "suspended");
        p.endpoint = endpoint;
        if (p.status == Status.None) p.status = Status.Registered;
        emit ProviderRegistered(msg.sender, endpoint);
    }

    /// @notice Coordinator records a passed benchmark; the provider becomes active once bonded.
    function attest(address provider, bytes32 benchmarkHash) external onlyOwner {
        Provider storage p = providers[provider];
        require(p.status == Status.Registered || p.status == Status.Active, "not registered");
        p.benchmarkHash = benchmarkHash;
        emit ProviderAttested(provider, benchmarkHash);
        if (p.bond >= minBond && p.bond > 0) p.status = Status.Active;
    }

    /// @notice Pulls RLUSD from the provider (approve first).
    function bond(uint256 amount) external {
        Provider storage p = providers[msg.sender];
        require(p.status == Status.Registered || p.status == Status.Active, "not registered");
        require(amount > 0, "zero");
        require(rlusd.transferFrom(msg.sender, address(this), amount), "transfer failed");
        p.bond += amount;
        if (p.benchmarkHash != bytes32(0) && p.bond >= minBond) p.status = Status.Active;
        emit Bonded(msg.sender, amount, p.bond);
    }

    /// @notice Withdraw needs the approver's EIP-712 signature and no open verification task.
    function withdrawBond(uint256 amount, uint256 deadline, bytes calldata approval) external {
        Provider storage p = providers[msg.sender];
        require(p.status != Status.Suspended, "suspended");
        require(openTasks[msg.sender] == 0, "verification pending");
        require(block.timestamp <= deadline, "approval expired");
        require(amount > 0 && amount <= p.bond, "bad amount");
        uint256 nonce = withdrawNonce[msg.sender]++;
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator,
            keccak256(abi.encode(WITHDRAW_TYPEHASH, msg.sender, amount, nonce, deadline))));
        require(_recover(digest, approval) == approver, "not approved");
        p.bond -= amount;
        if (p.bond < minBond && p.status == Status.Active) p.status = Status.Registered;
        require(rlusd.transfer(msg.sender, amount), "transfer failed");
        emit BondWithdrawn(msg.sender, amount);
    }

    /// @notice The service manager holds a provider's bond while a verification task is open.
    function lockBond(address provider, bool open) external onlyServiceManager {
        if (open) openTasks[provider]++;
        else if (openTasks[provider] > 0) openTasks[provider]--;
    }

    /// @notice Called by the service manager when a verification fails. Slashes the whole bond.
    function slash(address provider, bytes32 jobId, address buyer, address[] calldata verifiers) external onlyServiceManager {
        Provider storage p = providers[provider];
        require(p.status == Status.Registered || p.status == Status.Active, "not a provider");
        require(buyer != address(0), "zero buyer");
        uint256 total = p.bond;
        p.bond = 0;
        p.status = Status.Suspended;
        uint256 refund = total * REFUND_BPS / 10000;
        uint256 verifierReward = total * VERIFIER_BPS / 10000;
        uint256 treasuryShare = total - refund - verifierReward;
        if (refund > 0) require(rlusd.transfer(buyer, refund), "refund failed");
        if (verifierReward > 0 && verifiers.length > 0) {
            uint256 each = verifierReward / verifiers.length;
            for (uint256 i = 0; i < verifiers.length; i++) require(rlusd.transfer(verifiers[i], each), "reward failed");
            treasuryShare += verifierReward - each * verifiers.length;
            verifierReward = each * verifiers.length;
        } else {
            treasuryShare += verifierReward;
            verifierReward = 0;
        }
        if (treasuryShare > 0) require(rlusd.transfer(treasury, treasuryShare), "treasury failed");
        emit Slashed(provider, jobId, buyer, refund, verifierReward, treasuryShare);
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
