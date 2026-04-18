import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {registerComputer} from './computer.js';
import {registerWindowTools} from './window.js';

export function registerAll(server: McpServer): void {
	registerComputer(server);
	registerWindowTools(server);
}
