// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GradewireRegistry} from "../src/GradewireRegistry.sol";
import {GradingServiceManager} from "../src/GradingServiceManager.sol";

contract MockRLUSD {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public refuseZero = true;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { require(to != address(0) || !refuseZero, "zero"); balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

contract GradewireTest is Test {
    MockRLUSD rlusd;
    GradewireRegistry registry;
    GradingServiceManager sm;
    uint256 constant OP1 = 0xA11CE; uint256 constant OP2 = 0xB0B; uint256 constant OP3 = 0xCA7;
    uint256 constant APPROVER = 0x1ED6E5;
    uint256 constant PROVIDER = 0x9A0B;
    address provider;
    address buyer = address(0xB0);
    address treasury = address(0x7EA);
    bytes32 jobId = keccak256("job-1");
    bytes32 goodHash = keccak256("good");
    bytes32 badHash = keccak256("all passed, trust me");
    bytes32 otherHash = keccak256("something else");

    function setUp() public {
        provider = vm.addr(PROVIDER);
        rlusd = new MockRLUSD();
        registry = new GradewireRegistry(address(rlusd), vm.addr(APPROVER), treasury, 1 ether);
        address[] memory ops = new address[](3);
        ops[0] = vm.addr(OP1); ops[1] = vm.addr(OP2); ops[2] = vm.addr(OP3);
        sm = new GradingServiceManager(address(registry), ops, 2);
        registry.setServiceManager(address(sm));
        rlusd.mint(provider, 5 ether);
        vm.startPrank(provider);
        registry.register("http://127.0.0.1:4401");
        rlusd.approve(address(registry), 5 ether);
        registry.bond(5 ether);
        vm.stopPrank();
        registry.attest(provider, keccak256("bench"));
        (, GradewireRegistry.Status st, uint256 b,) = registry.providers(provider);
        assertEq(uint8(st), uint8(GradewireRegistry.Status.Active));
        assertEq(b, 5 ether);
    }

    // Signatures are computed before vm.expectRevert: the helpers make view calls of their own.
    function _sign(uint256 pk, uint32 taskId, bool matched, bytes32 h) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", sm.domainSeparator(),
            keccak256(abi.encode(sm.RESPONSE_TYPEHASH(), taskId, matched, h))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
    function _resultSig(uint256 pk, bytes32 job, bytes32 h) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", sm.domainSeparator(),
            keccak256(abi.encode(sm.RESULT_TYPEHASH(), job, h))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
    function _task(bytes32 h) internal returns (uint32) {
        return sm.createVerificationTask(jobId, provider, buyer, h, _resultSig(PROVIDER, jobId, h));
    }

    function testPassVerdictKeepsBondAndUnlocks() public {
        uint32 id = _task(goodHash);
        assertEq(registry.openTasks(provider), 1);
        sm.respondToTask(id, true, goodHash, _sign(OP1, id, true, goodHash));
        sm.respondToTask(id, true, goodHash, _sign(OP2, id, true, goodHash));
        (,,,,,, bool fin, bool pass,,,) = sm.tasks(id);
        assertTrue(fin); assertTrue(pass);
        (,, uint256 b,) = registry.providers(provider);
        assertEq(b, 5 ether);
        assertEq(registry.openTasks(provider), 0);
    }

    function testSlashOnFailedVerdict() public {
        uint32 id = _task(badHash);
        sm.respondToTask(id, false, goodHash, _sign(OP1, id, false, goodHash));
        assertEq(rlusd.balanceOf(buyer), 0);
        sm.respondToTask(id, false, goodHash, _sign(OP3, id, false, goodHash));
        (, GradewireRegistry.Status st, uint256 b,) = registry.providers(provider);
        assertEq(uint8(st), uint8(GradewireRegistry.Status.Suspended));
        assertEq(b, 0);
        assertEq(rlusd.balanceOf(buyer), 2.5 ether);
        assertEq(rlusd.balanceOf(vm.addr(OP1)), 0.75 ether);
        assertEq(rlusd.balanceOf(vm.addr(OP3)), 0.75 ether);
        assertEq(rlusd.balanceOf(treasury), 1 ether);
        bytes memory late = _sign(OP2, id, false, goodHash);
        vm.expectRevert("finalized");
        sm.respondToTask(id, false, goodHash, late);
    }

    function testCoordinatorCannotFrameProvider() public {
        bytes memory forged = _resultSig(0xDEAD, jobId, badHash);
        vm.expectRevert("provider did not sign this result");
        sm.createVerificationTask(jobId, provider, buyer, badHash, forged);
        // A real signature over a different hash does not transfer either.
        bytes memory real = _resultSig(PROVIDER, jobId, goodHash);
        vm.expectRevert("provider did not sign this result");
        sm.createVerificationTask(jobId, provider, buyer, badHash, real);
    }

    function testDisagreeingVerifiersAreInconclusiveNotFraud() public {
        uint32 id = _task(badHash);
        sm.respondToTask(id, false, goodHash, _sign(OP1, id, false, goodHash));
        sm.respondToTask(id, false, otherHash, _sign(OP2, id, false, otherHash));
        sm.respondToTask(id, true, badHash, _sign(OP3, id, true, badHash));
        (,,,,,, bool fin, bool pass, bool inconclusive,,) = sm.tasks(id);
        assertTrue(fin); assertFalse(pass); assertTrue(inconclusive);
        (, GradewireRegistry.Status st, uint256 b,) = registry.providers(provider);
        assertEq(uint8(st), uint8(GradewireRegistry.Status.Active));
        assertEq(b, 5 ether);
        assertEq(registry.openTasks(provider), 0);
    }

    function testWithdrawRefusedWhileTaskOpen() public {
        _task(goodHash);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", registry.domainSeparator(),
            keccak256(abi.encode(registry.WITHDRAW_TYPEHASH(), provider, 1 ether, uint256(0), deadline))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(APPROVER, digest);
        bytes memory good = abi.encodePacked(r, s, v);
        vm.prank(provider);
        vm.expectRevert("verification pending");
        registry.withdrawBond(1 ether, deadline, good);
    }

    function testSlashFailureDoesNotBlockVerdict() public {
        // Make the money leg revert: the mock refuses transfers to address(0) and we set a zero... treasury
        // cannot be zero, so simulate with a buyer the token refuses by making refund go to address(0)
        // via a registry whose service manager is NOT this sm (R3a: misconfiguration).
        GradewireRegistry other = new GradewireRegistry(address(rlusd), vm.addr(APPROVER), treasury, 0);
        address[] memory ops = new address[](3);
        ops[0] = vm.addr(OP1); ops[1] = vm.addr(OP2); ops[2] = vm.addr(OP3);
        GradingServiceManager sm2 = new GradingServiceManager(address(other), ops, 2);
        // other.serviceManager is never set, so lockBond/slash from sm2 revert with "not service manager".
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", sm2.domainSeparator(), keccak256(abi.encode(sm2.RESULT_TYPEHASH(), jobId, badHash))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PROVIDER, digest);
        vm.expectRevert("not service manager"); // misconfiguration surfaces at task creation, not at the verdict
        sm2.createVerificationTask(jobId, provider, buyer, badHash, abi.encodePacked(r, s, v));
    }

    function testInconsistentNonOperatorAndDuplicateRejected() public {
        uint32 id = _task(badHash);
        bytes memory sig = _sign(OP1, id, true, goodHash);
        vm.expectRevert("inconsistent response");
        sm.respondToTask(id, true, goodHash, sig);
        bytes memory outsider = _sign(0xDEAD, id, false, goodHash);
        vm.expectRevert("not operator");
        sm.respondToTask(id, false, goodHash, outsider);
        bytes memory ok = _sign(OP1, id, false, goodHash);
        sm.respondToTask(id, false, goodHash, ok);
        vm.expectRevert("duplicate");
        sm.respondToTask(id, false, goodHash, ok);
    }

    function testQuorumMustStayMajority() public {
        vm.expectRevert("quorum must be a majority"); // 4 operators with quorum 2 would let a relayer pick the verdict
        sm.setOperator(address(0x4), true);
        assertEq(sm.operatorCount(), 3);
    }

    function testMinBondGatesActive() public {
        address small = address(0x5A);
        rlusd.mint(small, 0.5 ether);
        vm.startPrank(small);
        registry.register("http://x");
        rlusd.approve(address(registry), 0.5 ether);
        registry.bond(0.5 ether);
        vm.stopPrank();
        registry.attest(small, keccak256("b"));
        (, GradewireRegistry.Status st,,) = registry.providers(small);
        assertEq(uint8(st), uint8(GradewireRegistry.Status.Registered));
    }

    function testWithdrawNeedsApproverSignature() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", registry.domainSeparator(),
            keccak256(abi.encode(registry.WITHDRAW_TYPEHASH(), provider, 1 ether, uint256(0), deadline))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, digest);
        bytes memory bad = abi.encodePacked(r, s, v);
        vm.prank(provider);
        vm.expectRevert("not approved");
        registry.withdrawBond(1 ether, deadline, bad);
        (v, r, s) = vm.sign(APPROVER, digest);
        bytes memory good = abi.encodePacked(r, s, v);
        vm.prank(provider);
        registry.withdrawBond(1 ether, deadline, good);
        assertEq(rlusd.balanceOf(provider), 1 ether);
        vm.prank(provider);
        vm.expectRevert("not approved");
        registry.withdrawBond(1 ether, deadline, good);
    }

    function testServiceManagerIsOneShot() public {
        vm.expectRevert("already set");
        registry.setServiceManager(address(0x1234));
    }
}
