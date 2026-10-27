// All Codex operations retain the CLI's configured provider and account.
export function codexAppServerArgs({ allowWeb = false, fastMode = false } = {}) {
  // Recent Codex versions route built-in web tools through this host, even with code_mode off.
  const args = ['app-server', '--listen', 'stdio://', '-c', 'mcp_servers={}', '-c', 'project_doc_max_bytes=0', '-c', `web_search="${allowWeb ? 'live' : 'disabled'}"`, '--enable', 'code_mode_host'];
  if (fastMode) args.push('--enable', 'fast_mode');
  for (const feature of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks', 'multi_agent', 'browser_use', 'computer_use', 'image_generation', 'code_mode', 'skill_search']) args.push('--disable', feature);
  return args;
}
