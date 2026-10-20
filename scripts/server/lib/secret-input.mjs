// Reads a passphrase: typed on the terminal (nothing is echoed), or the whole
// of stdin when it is not a terminal (automation: `printf … | psctl …`).
// Shared by scripts/db/offsite.mjs and scripts/server/psctl.mjs.

export async function readPassphrase(prompt) {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  process.stderr.write(prompt);
  return new Promise((resolve) => {
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    // A paste arrives as one chunk of many characters.
    process.stdin.on('data', function onData(chunk) {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stderr.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') process.exit(130);
        else if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    });
  });
}
