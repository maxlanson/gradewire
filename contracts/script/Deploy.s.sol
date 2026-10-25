// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {GradewireRegistry} from "../src/GradewireRegistry.sol";
import {GradingServiceManager} from "../src/GradingServiceManager.sol";

/// Env: COORDINATOR_PRIVATE_KEY (deployer/owner), RLUSD_TOKEN, APPROVER_ADDRESS, TREASURY_ADDRESS,
///      OPERATOR1_ADDRESS, OPERATOR2_ADDRESS, OPERATOR3_ADDRESS
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("COORDINATOR_PRIVATE_KEY");
        address[] memory ops = new address[](3);
        ops[0] = vm.envAddress("OPERATOR1_ADDRESS");
        ops[1] = vm.envAddress("OPERATOR2_ADDRESS");
        ops[2] = vm.envAddress("OPERATOR3_ADDRESS");
        vm.startBroadcast(pk);
        GradewireRegistry registry = new GradewireRegistry(vm.envAddress("RLUSD_TOKEN"), vm.envAddress("APPROVER_ADDRESS"), vm.envAddress("TREASURY_ADDRESS"), vm.envOr("MIN_BOND_WEI", uint256(10000000000000000)));
        GradingServiceManager sm = new GradingServiceManager(address(registry), ops, 2);
        registry.setServiceManager(address(sm));
        vm.stopBroadcast();
        console.log("REGISTRY", address(registry));
        console.log("SERVICE_MANAGER", address(sm));
    }
}
