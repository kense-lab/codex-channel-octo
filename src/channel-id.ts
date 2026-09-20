/** Group APIs address the parent group; conversation state keeps the full topic ID. */
export function parentGroupNo(channelId: string): string {
  return channelId.split('____', 1)[0];
}
