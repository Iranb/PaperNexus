import readline from 'node:readline';

export function createPromptSession(options = {}) {
  const rl = readline.createInterface({
    input: options.input || process.stdin,
    output: options.output || process.stdout,
    terminal: Boolean((options.output || process.stdout)?.isTTY)
  });
  const lines = rl[Symbol.asyncIterator]();

  async function readLine(promptText) {
    if (options.output || process.stdout) {
      (options.output || process.stdout).write(promptText);
    }

    const next = await lines.next();
    if (next.done) {
      return '';
    }

    return String(next.value || '').trim();
  }

  return {
    async promptLine(label, defaultValue = '') {
      const suffix = defaultValue ? ` [${defaultValue}]` : '';
      const answer = await readLine(`${label}${suffix}: `);
      return answer || defaultValue;
    },

    async promptChoice(label, choices = [], defaultValue = '') {
      const normalizedChoices = Array.isArray(choices)
        ? choices
          .map((choice) => String(choice || '').trim())
          .filter(Boolean)
        : [];

      if (!normalizedChoices.length) {
        throw new Error('promptChoice requires at least one choice.');
      }

      const fallback = normalizedChoices.includes(defaultValue) ? defaultValue : normalizedChoices[0];
      if (options.output || process.stdout) {
        (options.output || process.stdout).write(`${label}\n`);
        normalizedChoices.forEach((choice, index) => {
          const marker = choice === fallback ? ' (default)' : '';
          (options.output || process.stdout).write(`  ${index + 1}) ${choice}${marker}\n`);
        });
      }

      const answer = (await readLine(`Choose [${normalizedChoices.indexOf(fallback) + 1}]: `)).trim();
      if (!answer) return fallback;

      const selectedIndex = Number(answer);
      if (Number.isInteger(selectedIndex) && selectedIndex >= 1 && selectedIndex <= normalizedChoices.length) {
        return normalizedChoices[selectedIndex - 1];
      }

      const directMatch = normalizedChoices.find((choice) => choice.toLowerCase() === answer.toLowerCase());
      if (directMatch) {
        return directMatch;
      }

      throw new Error(`Invalid choice "${answer}". Expected one of: ${normalizedChoices.join(', ')}`);
    },

    async promptConfirm(label, defaultValue = true) {
      const suffix = defaultValue ? ' [Y/n]' : ' [y/N]';
      const answer = (await readLine(`${label}${suffix}: `)).toLowerCase();
      if (!answer) return defaultValue;
      return answer === 'y' || answer === 'yes';
    },

    close() {
      rl.close();
    }
  };
}

export async function promptSecret(promptText = 'Secret: ') {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive secret prompt requires a TTY. Use `--stdin` to pipe the key instead.');
  }

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    let value = '';

    function cleanup() {
      stdin.off('data', onData);
      if (typeof stdin.setRawMode === 'function') {
        stdin.setRawMode(false);
      }
      stdin.pause();
    }

    function onData(chunk) {
      const text = String(chunk);
      for (const char of text) {
        if (char === '\u0003') {
          cleanup();
          reject(new Error('Cancelled.'));
          return;
        }

        if (char === '\r' || char === '\n') {
          stdout.write('\n');
          cleanup();
          resolve(value);
          return;
        }

        if (char === '\u007f') {
          value = value.slice(0, -1);
          continue;
        }

        value += char;
      }
    }

    stdout.write(promptText);
    if (typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.on('data', onData);
  });
}

export async function readSecretFromStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  return Buffer.concat(chunks).toString('utf8').trim();
}
