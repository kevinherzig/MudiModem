local cjson = require "cjson"
local rpc = require "oui.rpc"
local ubus = require "oui.ubus"

cjson.encode_empty_table_as_object(false)

if ngx.req.get_method() ~= "POST" then
    ngx.exit(ngx.HTTP_FORBIDDEN)
end

ngx.req.read_body()

local data = ngx.req.get_body_data()
if not data then
    local name = ngx.req.get_body_file()
    local f = io.open(name, "r")
    data = f:read("*a")
    f:close()
end

local function rpc_method_challenge(id, params)
    local res = ubus.call("gl-session", "challenge", params)
    local code, data = res.code, res.data

    if code ~= 0 then
        local resp = rpc.error_response(id, code, data)
        ngx.say(cjson.encode(resp))
        return
    end

    local resp = rpc.result_response(id, data)
    ngx.say(cjson.encode(resp))
end

local function rpc_method_login(id, params)
    local res = ubus.call("gl-session", "login", params)
    local code, data = res.code, res.data

    if code ~= 0 then
        ngx.log(ngx.ERR, "login failed")
        local resp = rpc.error_response(id, code, data)
        ngx.say(cjson.encode(resp))
        return
    end

    ngx.log(ngx.NOTICE, "login successful")

    ngx.header["Set-Cookie"] = "Admin-Token=" .. data.sid

    local resp = rpc.result_response(id, data)
    ngx.say(cjson.encode(resp))
end

local function rpc_method_logout(id, params)
    ngx.log(ngx.NOTICE, "logout successful")

    ubus.call("gl-session", "logout", params)

    local resp = rpc.result_response(id)
    ngx.say(cjson.encode(resp))
end

local function rpc_method_alive(id, params)
    local res = ubus.call("gl-session", "touch", params)

    if res.code ~= 0 then
        local resp = rpc.error_response(id, res.code, data)
        ngx.say(cjson.encode(resp))
        return
    end

    local resp = rpc.result_response(id)
    ngx.say(cjson.encode(resp))
end

local function rpc_method_call(id, params)
    if #params < 3 then
        local resp = rpc.error_response(id, rpc.ERROR_CODE_INVALID_PARAMS)
        ngx.say(cjson.encode(resp))
        return
    end

    local sid, object, method, args = params[1], params[2], params[3], params[4]

    if type(sid) ~= "string" or type(object) ~= "string" or type(method) ~= "string" then
        local resp = rpc.error_response(id, rpc.ERROR_CODE_INVALID_PARAMS)
        ngx.say(cjson.encode(resp))
        return
    end

    if not object:match('^[%a_][%w%-_]+$') or not method:match('^[%a_][%w%-_]+$') then
        local resp = rpc.error_response(id, rpc.ERROR_CODE_INVALID_PARAMS)
        ngx.say(cjson.encode(resp))
        return
    end

    if args and type(args) ~= "table" then
        local resp = rpc.error_response(id, rpc.ERROR_CODE_INVALID_PARAMS)
        ngx.say(cjson.encode(resp))
        return
    end

    ngx.ctx.sid = sid

    if not rpc.is_no_auth(object, method) then
        if not rpc.access("rpc", object .. "." .. method) then
            local resp = rpc.error_response(id, rpc.ERROR_CODE_ACCESS)
            ngx.say(cjson.encode(resp))
            return
        end
    end

    local res, err = rpc.call(object, method, args)
    if type(res) == "number" then
        local resp = rpc.error_response(id, res)
        if resp.error and err then
            resp.error.err = err
        end
        ngx.say(cjson.encode(resp))
        return
    end

    if type(res) ~= "table" then res = {} end

    local resp = rpc.result_response(id, res)
    ngx.say(cjson.encode(resp))
end

local methods= {
    ["challenge"] = rpc_method_challenge,
    ["login"] = rpc_method_login,
    ["logout"] = rpc_method_logout,
    ["alive"] = rpc_method_alive,
    ["call"] = rpc_method_call
}

local ok, json_data = pcall(cjson.decode, data)
if not ok then
    local resp = rpc.error_response(nil, rpc.ERROR_CODE_PARSE_ERROR)
    ngx.say(cjson.encode(resp))
    return
end

if type(json_data) ~= "table" then
    local resp = rpc.error_response(nil, rpc.ERROR_CODE_PARSE_ERROR)
    ngx.say(cjson.encode(resp))
    return
end

if type(json_data.method) ~= "string" then
    local resp = rpc.error_response(json_data.id, rpc.ERROR_CODE_INVALID_REQUEST)
    ngx.say(cjson.encode(resp))
    return
end

if json_data.params and type(json_data.params) ~= "table" then
    local resp = rpc.error_response(json_data.id, rpc.ERROR_CODE_INVALID_REQUEST)
    ngx.say(cjson.encode(resp))
    return
end

if not methods[json_data.method] then
    local resp = rpc.error_response(json_data.id, rpc.ERROR_CODE_METHOD_NOT_FOUND)
    ngx.say(cjson.encode(resp))
    return
end

methods[json_data.method](json_data.id, json_data.params or {})
