import chalk from 'chalk';
import ora, { Ora } from 'ora';

// Human-friendly output (with colors and symbols)
export function success(message: string): void {
  console.log(chalk.green('✓'), message);
}

export function error(message: string): void {
  console.log(chalk.red('✗'), message);
}

export function info(message: string): void {
  console.log(chalk.blue('ℹ'), message);
}

export function warn(message: string): void {
  console.log(chalk.yellow('⚠'), message);
}

export function spinner(text: string): Ora {
  return ora(text).start();
}

export function printHeader(title: string): void {
  console.log();
  console.log(chalk.bold.cyan(title));
  console.log(chalk.gray('─'.repeat(title.length)));
  console.log();
}

export function printKeyValue(key: string, value: string): void {
  console.log(chalk.gray(`${key}:`), chalk.white(value));
}

export function printSection(title: string): void {
  console.log();
  console.log(chalk.bold(title));
}

// LLM-friendly output (structured, compact, no colors)
export function llmSection(title: string): void {
  try {
    console.log();
    console.log(title.toUpperCase());
    console.log();
  } catch (err: any) {
    if (err.code === 'EPIPE') {
      process.exit(0);
    }
    throw err;
  }
}

export function llmKeyValue(key: string, value: string): void {
  try {
    console.log(`${key}: ${value}`);
  } catch (err: any) {
    if (err.code === 'EPIPE') {
      process.exit(0);
    }
    throw err;
  }
}

export function llmTable(headers: string[], rows: string[][]): void {
  if (rows.length === 0) return;

  try {
    const colWidths = headers.map((h, i) => {
      const maxDataWidth = Math.max(...rows.map(r => (r[i] || '').length));
      return Math.max(h.length, maxDataWidth);
    });

    const separator = '|' + colWidths.map(w => '-'.repeat(w + 2)).join('|') + '|';
    const headerRow = '|' + headers.map((h, i) => ` ${h.padEnd(colWidths[i])} `).join('|') + '|';

    console.log(headerRow);
    console.log(separator);

    for (const row of rows) {
      const rowStr = '|' + row.map((cell, i) => ` ${(cell || '').padEnd(colWidths[i])} `).join('|') + '|';
      console.log(rowStr);
    }
  } catch (err: any) {
    if (err.code === 'EPIPE') {
      process.exit(0);
    }
    throw err;
  }
}

export function llmList(items: Array<{ key: string; value: string; indent?: number }>): void {
  for (const item of items) {
    const indent = '  '.repeat(item.indent || 0);
    console.log(`${indent}${item.key}: ${item.value}`);
  }
}
