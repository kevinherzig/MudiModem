-- On-device test for mudimodem.library_status / refresh_library. Runs the real
-- plugin against a FAKE lib tool (no network). Env: MM_PLUGIN, MUDIMODEM_LIB_TOOL.
package.loaded["oui.ubus"] = { call = function() error("must not touch ubus") end }

local M = dofile(os.getenv("MM_PLUGIN") or "/usr/lib/oui-httpd/rpc/mudimodem")
assert(type(M.library_status) == "function", "library_status missing")
assert(type(M.refresh_library) == "function", "refresh_library missing")

local s = M.library_status({})
assert(s.checked == true and s.update_available == true, "status must pass the check JSON through")
assert(s.local_revision == "old111" and s.remote_revision == "new222", "revisions passed through")

local r = M.refresh_library({})
assert(r.ok == true and r.revision == "new222" and r.count == 7, "refresh JSON passed through")

print("library backend OK")
