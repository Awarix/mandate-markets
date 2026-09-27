// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MandateRulebook} from "../src/MandateRulebook.sol";

/// The few Foundry cheatcodes these tests use, declared here rather than vendoring forge-std.
interface Vm {
    function prank(address) external;
    function warp(uint256) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function assume(bool) external;
}

contract MandateRulebookTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant OPERATOR = address(0xA11CE);
    address private constant STRANGER = address(0xB0B);

    // The ninth block's rules, as the desk booted them on 2026-09-27 (docs/LOG.md, 14:28:45Z).
    bytes32 private constant NINTH = 0x3e5aeeb4a90da8bb950130f44208a09ede9846a3a0d0b773c6b1a3139f8a840f;
    // casting to bytes20 is safe because the literal is exactly a 20-byte git SHA-1
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes20 private constant NINTH_COMMIT = bytes20(hex"bf1c74549c93763e6892d4edc45cc6bb07dd9bd1");
    uint64 private constant NINTH_AT = 1790519327; // 2026-09-27T14:28:47Z

    MandateRulebook private book;

    function setUp() public {
        vm.warp(NINTH_AT + 3 hours);
        book = new MandateRulebook(OPERATOR);
    }

    function _publish(bytes32 h, uint64 at) private returns (uint256) {
        vm.prank(OPERATOR);
        // truncating is intended: any 20 bytes stand in for a commit in these tests
        // forge-lint: disable-next-line(unsafe-typecast)
        return book.publish(h, bytes20(h), at, "");
    }

    // --- publishing ---

    function test_publishRecordsTheEntry() public {
        vm.prank(OPERATOR);
        uint256 i = book.publish(NINTH, NINTH_COMMIT, NINTH_AT, "fresh-only + the fuse (tasks/79, tasks/70 s2)");
        require(i == 0, "first index");
        require(book.count() == 1, "count");
        MandateRulebook.Rules memory r = book.latest();
        require(r.rulesHash == NINTH, "hash");
        require(r.commit == NINTH_COMMIT, "commit");
        require(r.effectiveAt == NINTH_AT, "effectiveAt");
        require(r.publishedAt == NINTH_AT + 3 hours, "publishedAt is block time");
        // The desk's own 12-hex fingerprint is the first six bytes.
        require(bytes6(r.rulesHash) == bytes6(0x3e5aeeb4a90d), "fingerprint prefix");
    }

    function test_onlyTheOperatorPublishes() public {
        vm.prank(STRANGER);
        vm.expectRevert(MandateRulebook.NotOperator.selector);
        book.publish(NINTH, NINTH_COMMIT, NINTH_AT, "");
    }

    function test_refusesAnEmptyHash() public {
        vm.prank(OPERATOR);
        vm.expectRevert(MandateRulebook.EmptyHash.selector);
        book.publish(bytes32(0), NINTH_COMMIT, NINTH_AT, "");
    }

    function test_refusesARuleInForceAfterItIsPublished() public {
        uint64 future = uint64(block.timestamp) + 1;
        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(MandateRulebook.EffectiveInFuture.selector, future, block.timestamp));
        book.publish(NINTH, NINTH_COMMIT, future, "");
    }

    function test_refusesToRewriteHistory() public {
        _publish(NINTH, NINTH_AT);
        vm.prank(OPERATOR);
        vm.expectRevert(
            abi.encodeWithSelector(MandateRulebook.EffectiveBeforePrevious.selector, NINTH_AT - 1, NINTH_AT)
        );
        book.publish(keccak256("older"), NINTH_COMMIT, NINTH_AT - 1, "");
    }

    function test_sameSecondCorrectionSupersedes() public {
        _publish(keccak256("typo"), NINTH_AT);
        _publish(NINTH, NINTH_AT);
        (uint256 i, MandateRulebook.Rules memory r) = book.ruleAt(NINTH_AT);
        require(i == 1 && r.rulesHash == NINTH, "the correction is in force");
        require(book.rules(0).rulesHash == keccak256("typo"), "and the mistake stays visible");
    }

    // --- reading ---

    function test_latestRevertsWhenEmpty() public {
        vm.expectRevert(MandateRulebook.NoRules.selector);
        book.latest();
    }

    function test_ruleAtFindsTheRuleInForce() public {
        _publish(keccak256("a"), 100);
        _publish(keccak256("b"), 200);
        _publish(keccak256("c"), 300);

        (uint256 i,) = book.ruleAt(100);
        require(i == 0, "at the first start");
        (i,) = book.ruleAt(199);
        require(i == 0, "just before the second");
        (i,) = book.ruleAt(200);
        require(i == 1, "at the second start");
        (i,) = book.ruleAt(type(uint64).max);
        require(i == 2, "long after the last");

        vm.expectRevert(abi.encodeWithSelector(MandateRulebook.NoRuleAt.selector, uint64(99)));
        book.ruleAt(99);
    }

    /// `ruleAt`'s binary search against a plain scan, on any non-decreasing history.
    function testFuzz_ruleAtMatchesALinearScan(uint16[8] memory gaps, uint8 n, uint64 t) public {
        n = uint8(bound(n, 1, 8));
        uint64 at = 1_000;
        uint64[] memory starts = new uint64[](n);
        for (uint256 k = 0; k < n; k++) {
            at += gaps[k]; // a gap of 0 is a same-second correction
            starts[k] = at;
            _publish(keccak256(abi.encode(k)), at);
        }
        uint256 expected = type(uint256).max;
        for (uint256 k = 0; k < n; k++) {
            if (starts[k] <= t) expected = k;
        }
        if (expected == type(uint256).max) {
            vm.expectRevert(abi.encodeWithSelector(MandateRulebook.NoRuleAt.selector, t));
            book.ruleAt(t);
        } else {
            (uint256 i,) = book.ruleAt(t);
            require(i == expected, "binary search disagrees with the scan");
        }
    }

    // --- the operator ---

    function test_constructorRefusesTheZeroAddress() public {
        vm.expectRevert(MandateRulebook.ZeroAddress.selector);
        new MandateRulebook(address(0));
    }

    function test_operatorMovesInTwoSteps() public {
        vm.prank(OPERATOR);
        book.transferOperator(STRANGER);
        require(book.operator() == OPERATOR, "nothing moves on the first step");

        vm.prank(address(0xC0FFEE));
        vm.expectRevert(MandateRulebook.NotPendingOperator.selector);
        book.acceptOperator();

        vm.prank(STRANGER);
        book.acceptOperator();
        require(book.operator() == STRANGER, "the named address took over");
        require(book.pendingOperator() == address(0), "and the offer is spent");

        vm.prank(OPERATOR);
        vm.expectRevert(MandateRulebook.NotOperator.selector);
        book.publish(NINTH, NINTH_COMMIT, NINTH_AT, "");
    }

    function test_onlyTheOperatorNamesTheNext() public {
        vm.prank(STRANGER);
        vm.expectRevert(MandateRulebook.NotOperator.selector);
        book.transferOperator(STRANGER);
    }

    function bound(uint256 x, uint256 lo, uint256 hi) private pure returns (uint256) {
        return lo + (x % (hi - lo + 1));
    }
}
