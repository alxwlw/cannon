// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract PlanFixture {
  event DelaySet(uint256 delay);
  address public owner;
  address public nominatedOwner;
  uint256 private _value;
  uint256 private _delay;
  mapping(uint128 => uint256) private _limit;
  address[] private _allow;
  constructor(address o) { owner = o; }
  function nominateNewOwner(address n) external { nominatedOwner = n; }
  function setValue(uint256 v) external { _value = v; }
  function getValue() external view returns (uint256) { return _value; }
  function setLimit(uint128 id, uint256 v) external { _limit[id] = v; }
  function getLimit(uint128 id) external view returns (uint256) { return _limit[id]; }
  function addToAllowlist(address a) external { _allow.push(a); }
  function getAllowlist() external view returns (address[] memory) { return _allow; }
  function setDelay(uint256 d) external { _delay = d == 0 ? 1 : d; emit DelaySet(_delay); }
  function getDelay() external view returns (uint256) { return _delay; }
  function initializeThing(bytes32 x) external {} // no derivable getter → unchecked
}
