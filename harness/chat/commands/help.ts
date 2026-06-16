// /help — list all registered commands with descriptions.

import { escapeHtml } from '../formatters.js';
import type { Command, CommandRegistry } from './registry.js';

export function makeHelpCommand(registry: CommandRegistry): Command {
  return {
    name: 'help',
    description: 'Show available commands',
    handler: async (ctx) => {
      const lines = ['<b>Available commands</b>', ''];
      for (const cmd of registry.all()) {
        const ownerNote = cmd.ownerOnly ? ' <i>(owner only)</i>' : '';
        lines.push(`/${cmd.name} — ${escapeHtml(cmd.description)}${ownerNote}`);
      }
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
    },
  };
}
