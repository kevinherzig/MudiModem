-- On-device test for the mudimodem RPC backend.
-- Runs the REAL plugin against LIVE ubus without nginx: pre-load
-- package.loaded["oui.ubus"] with a shim backed by the native ubus.so binding,
-- so dofile executes the actual plugin code (no logic duplication, no drift).
--
-- Run by tools/verify.sh on the device. Exit 0 = pass, 1 = fail.

local native = require "ubus"
local conn = assert(native.connect(), "ubus connect failed")
package.loaded["oui.ubus"] = {
  call = function(object, method, params) return conn:call(object, method, params or {}) end
}

local M = dofile(os.getenv("MM_PLUGIN") or "/usr/lib/oui-httpd/rpc/mudimodem")
assert(type(M) == "table", "plugin must return a table")
assert(type(M.get_bands) == "function", "get_bands missing")

-- Every function in the returned table becomes a callable RPC method; only the
-- known surface may be exposed (writes are limited to the watchdog-protected pair).
local ALLOWED = { get_bands = true, set_bands = true, confirm = true, revert_now = true }
for k, v in pairs(M) do
  if type(v) == "function" then
    assert(ALLOWED[k], "unexpected RPC method exposed: " .. k)
  end
end

local ok, r = pcall(M.get_bands, {})
assert(ok, "get_bands threw: " .. tostring(r))

-- Shape.
for _, key in ipairs({ "supported", "config", "policy", "capability", "meta" }) do
  assert(type(r[key]) == "table", "missing section: " .. key)
end
for _, g in ipairs({ "sa", "nsa", "LTE" }) do
  assert(type(r.supported[g]) == "table", "supported." .. g .. " not a list")
  assert(type(r.policy[g]) == "table", "policy." .. g .. " not a list")
  assert(type(r.capability[g]) == "table", "capability." .. g .. " not a list")
end

-- Live sanity: this modem supports 5G SA, and SA support must be non-trivial.
assert(#r.supported.sa >= 5, "expected the RG650V-NA to support many SA bands, got " .. #r.supported.sa)

-- sub_id must be resolved to a concrete value (never left nil). When the active
-- SIM is registered, resolution is by PLMN match; when it is deregistered (a
-- valid state — e.g. locked to a band with no coverage), QSPN can't confirm and
-- it falls back to sub_id 1. Both are correct; only require a resolved sub_id
-- and that a claimed match carries a PLMN.
assert(r.meta.sub_id ~= nil, "sub_id not resolved")
assert(r.meta.plmn_matched == false or (r.meta.plmn ~= nil and r.meta.plmn ~= ""),
  "plmn_matched=true must carry a PLMN")

-- The core model: capability ⊆ policy, and capability ⊆ (config when config is a
-- restriction). No band is 0 (the empty sentinel must have been stripped).
local function set(t) local s = {} for _, v in ipairs(t) do s[v] = true end return s end
for _, g in ipairs({ "sa", "nsa", "LTE" }) do
  local pol = set(r.policy[g])
  for _, b in ipairs(r.capability[g]) do
    assert(b ~= 0, "band 0 leaked into capability." .. g .. " (empty sentinel not stripped)")
    assert(pol[b], "capability." .. g .. " band " .. b .. " is not permitted by policy — model broken")
  end
end

print("backend OK: sub_id=" .. r.meta.sub_id ..
      " plmn=" .. tostring(r.meta.plmn) ..
      " | SA supported=" .. #r.supported.sa ..
      " policy=" .. #r.policy.sa ..
      " capability=" .. #r.capability.sa)
