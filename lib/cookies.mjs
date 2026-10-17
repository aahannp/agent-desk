// Browsers don't separate cookies by port, so Agent Desk's login cookie (desk_<port>, the full token) would
// go to every server on 127.0.0.1. This removes it from a Cookie header bound for anywhere else.
export function stripDeskCookies(header) {
  return String(header ?? '').split(';').map(c => c.trim())
    .filter(c => c && !c.split('=', 1)[0].trim().startsWith('desk_')).join('; ');
}
