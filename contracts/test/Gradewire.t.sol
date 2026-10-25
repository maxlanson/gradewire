// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GradewireRegistry} from "../src/GradewireRegistry.sol";
import {GradingServiceManager} from "../src/GradingServiceManager.sol";

contract MockRLUSD {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
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
    address provider = address(0xA1);
    address buyer = address(0xB0);
    address treasury = address(0x7EA);
    bytes32 jobId = keccak256("job-1");
    bytes32 goodHash = keccak256("good");
    bytes32 badHash = keccak256("all passed, trust me");

    function setUp() public {
        rlusd = new MockRLUSD();
        registry = new GradewireRegistry(address(rlusd), vm.addr(APPROVER), treasury);
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

    // Signatures are computed before vm.expectRevert: the helper makes view calls of its own.
    function _sign(uint256 pk, uint32 taskId, bool matched, bytes32 h) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", sm.domainSeparator(),
            keccak256(abi.encode(sm.RESPONSE_TYPEHASH(), taskId, matched, h))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function testPassVerdictKeepsBond() public {
        uint32 id = sm.createVerificationTask(jobId, provider, buyer, goodHash);
        sm.respondToTask(id, true, goodHash, _sign(OP1, id, true, goodHash));
        sm.respondToTask(id, true, goodHash, _sign(OP2, id, true, goodHash));
        (,,,,,, bool fin, bool pass) = sm.tasks(id);
        assertTrue(fin); assertTrue(pass);
        (,, uint256 b,) = registry.providers(provider);
        assertEq(b, 5 ether);
    }

    function testSlashOnFailedVerdict() public {
        uint32 id = sm.createVerificationTask(jobId, provider, buyer, badHash);
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

    function testInconsistentResponseRejected() public {
        uint32 id = sm.createVerificationTask(jobId, provider, buyer, badHash);
        bytes memory sig = _sign(OP1, id, true, goodHash);
        vm.expectRevert("inconsistent response");
        sm.respondToTask(id, true, goodHash, sig);
    }

    function testNonOperatorAndDuplicateRejected() public {
        uint32 id = sm.createVerificationTask(jobId, provider, buyer, goodHash);
        bytes memory outsider = _sign(0xDEAD, id, true, goodHash);
        vm.expectRevert("not operator");
        sm.respondToTask(id, true, goodHash, outsider);
        bytes memory sig = _sign(OP1, id, true, goodHash);
        sm.respondToTask(id, true, goodHash, sig);
        vm.expectRevert("duplicate");
        sm.respondToTask(id, true, goodHash, sig);
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
}
