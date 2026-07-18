-- Argument validator for the mudimodem RPC object.
--
-- ⚠️ REQUIRED, not optional. oui-lib-rpc.lua applies a DEFAULT allowlist to
-- every string param when no per-object validator entry exists:
--     ^[%w%.%s%-_:#/]-$   (letters/digits/_ . whitespace - : # / only)
-- That set has NO '+', '=', '"', ',', '(', ')', so every real AT command
-- (AT+CSQ, AT+QENG="servingcell", AT+QNWPREFCFG="nr5g_band",…) is rejected with
-- -32602 "Invalid params of cmd" BEFORE our backend ever runs — only bare
-- ATI / AT slip through. This mirrors GL's own modem.lua, which validates
-- send_at_command's `command` param with '.-' (match anything) for exactly this
-- reason.
--
-- Safety lives in the backend, not here: at_console strips CR/LF, caps length
-- at 256, and single-quote-escapes cmd for the shell — so accepting any content
-- ('.-') is safe and follows GL's precedent.
--
-- Only at_console needs an override. Methods absent from this table fall back to
-- the oui default (get_bands/set_bands/confirm/revert_now/get_history all pass
-- it — they carry only band numbers and alnum mode strings like "AUTO"), so
-- listing them would be redundant. `timeout` is a number, which oui accepts
-- without pattern-matching, so it needs no entry either.
return {
  at_console = { cmd = '.-' },
}
