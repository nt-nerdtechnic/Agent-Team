/** Shell-escape a path so it can be safely pasted into a PTY command line. */
export function shellEscape(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`
}
