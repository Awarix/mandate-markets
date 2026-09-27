// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  MandateRulebook
/// @author Mandate Markets
/// @notice A public, append-only record of the rules Mandate's trading desk runs under.
///
///         Mandate trades its users' own Hyperliquid accounts inside limits that live in version
///         control — five groups of money constants (`RISK_PARAMS`, `DEFAULT_USER_SETTINGS`,
///         `LIVE_MANDATE`, `BUILDER_FEE`, `SITE_OFFERS`). Every time the desk boots it hashes them:
///         SHA-256 over the sorted `name = value` lines (`src/ops/config-event.ts`), whose first six
///         bytes are the 12-hex fingerprint the desk logs. When that hash changes, the operator
///         publishes the full hash here, with the commit that holds those constants and the second
///         the desk began trading on them.
///
///         So *which rules was my account traded under at time t* has an answer nobody can rewrite
///         afterwards: `ruleAt(t)` gives the hash and the commit, the commit gives the file, and the
///         file hashes to the published value.
///
///         What this contract does **not** do: hold funds, touch any account, or enforce anything.
///         The limits are enforced off-chain by the desk; this is the tamper-evident record of which
///         ones were in force, and when.
contract MandateRulebook {
    /// One set of rules and when it applied.
    struct Rules {
        /// SHA-256 of the canonical constants text. Its first six bytes are the desk's fingerprint.
        bytes32 rulesHash;
        /// The git commit whose constants hash to `rulesHash`.
        bytes20 commit;
        /// Unix seconds at which the desk began trading on these rules (its boot `config` event).
        uint64 effectiveAt;
        /// Block time at which this entry was published — never earlier than `effectiveAt`.
        uint64 publishedAt;
    }

    /// The only address that may publish. Moved by a two-step transfer, never by one call.
    address public operator;
    /// The address `transferOperator` named, until it accepts.
    address public pendingOperator;

    Rules[] private _rules;

    event RulesPublished(
        uint256 indexed index, bytes32 indexed rulesHash, bytes20 commit, uint64 effectiveAt, string note
    );
    event OperatorTransferStarted(address indexed operator, address indexed pendingOperator);
    event OperatorTransferred(address indexed previousOperator, address indexed newOperator);

    error NotOperator();
    error NotPendingOperator();
    error ZeroAddress();
    error EmptyHash();
    /// A rule cannot be recorded as in force before it is published.
    error EffectiveInFuture(uint64 effectiveAt, uint256 blockTime);
    /// Entries are in the order the desk ran them; history is appended, never inserted into.
    error EffectiveBeforePrevious(uint64 effectiveAt, uint64 previous);
    error NoRules();
    error NoRuleAt(uint64 t);

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address initialOperator) {
        if (initialOperator == address(0)) revert ZeroAddress();
        operator = initialOperator;
        emit OperatorTransferred(address(0), initialOperator);
    }

    /// @notice Record the rules the desk began trading on at `effectiveAt`.
    /// @dev    Append-only. An entry with the same `effectiveAt` as the last one is allowed and
    ///         supersedes it in `ruleAt` — the only way to correct a mistake, and a visible one.
    /// @param  note A short human line (what changed, the task it came from); kept in the event only.
    function publish(bytes32 rulesHash, bytes20 commit, uint64 effectiveAt, string calldata note)
        external
        onlyOperator
        returns (uint256 index)
    {
        if (rulesHash == bytes32(0)) revert EmptyHash();
        // A sanity bound, not a price or a deadline: a sequencer's few seconds of skew can only move
        // which second counts as "now" for a rule that is already in force.
        // forge-lint: disable-next-line(block-timestamp)
        if (effectiveAt > block.timestamp) revert EffectiveInFuture(effectiveAt, block.timestamp);
        index = _rules.length;
        if (index > 0) {
            uint64 previous = _rules[index - 1].effectiveAt;
            if (effectiveAt < previous) revert EffectiveBeforePrevious(effectiveAt, previous);
        }
        _rules.push(Rules(rulesHash, commit, effectiveAt, uint64(block.timestamp)));
        emit RulesPublished(index, rulesHash, commit, effectiveAt, note);
    }

    /// @notice How many entries have been published.
    function count() external view returns (uint256) {
        return _rules.length;
    }

    /// @notice The entry at `index`, in publication order.
    function rules(uint256 index) external view returns (Rules memory) {
        return _rules[index];
    }

    /// @notice The most recently published entry — the rules in force now, if the desk is running.
    function latest() external view returns (Rules memory) {
        uint256 n = _rules.length;
        if (n == 0) revert NoRules();
        return _rules[n - 1];
    }

    /// @notice The rules in force at time `t`: the last entry whose `effectiveAt` is at or before it.
    /// @dev    Binary search over an array kept sorted by `publish`. Reverts before the first entry.
    function ruleAt(uint64 t) external view returns (uint256 index, Rules memory r) {
        uint256 lo = 0;
        uint256 hi = _rules.length;
        // Find the first entry that starts after t; the one before it is in force.
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (_rules[mid].effectiveAt <= t) lo = mid + 1;
            else hi = mid;
        }
        if (lo == 0) revert NoRuleAt(t);
        index = lo - 1;
        r = _rules[index];
    }

    /// @notice Name the next operator. Nothing moves until that address calls `acceptOperator`.
    function transferOperator(address next) external onlyOperator {
        if (next == address(0)) revert ZeroAddress();
        pendingOperator = next;
        emit OperatorTransferStarted(operator, next);
    }

    /// @notice Take over as operator. Only the address `transferOperator` named can.
    function acceptOperator() external {
        if (msg.sender != pendingOperator) revert NotPendingOperator();
        emit OperatorTransferred(operator, msg.sender);
        operator = msg.sender;
        pendingOperator = address(0);
    }
}
