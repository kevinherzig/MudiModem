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

local M = dofile("/usr/lib/oui-httpd/rpc/mudimodem")
assert(type(M) == "table", "plugin must return a table")
assert(type(M.get_bands) == "function", "get_bands missing")

-- The plugin must expose ONLY read methods in this phase (any function in the
-- returned table becomes a callable RPC method).
for k, v in pairs(M) do
  if type(v) == "function" then
    assert(k:match("^get_") or k == "confirm",
      "unexpected non-get method exposed: " .. k .. " (writes must wait for the watchdog)")
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

-- sub_id must be resolved by PLMN match, never left at the unstable default.
assert(r.meta.sub_id ~= nil, "sub_id not resolved")
assert(r.meta.plmn_matched == true,
  "sub_id was NOT PLMN-matched (guessed) — active-SIM data may be wrong")

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
