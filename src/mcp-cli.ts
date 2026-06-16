#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildServer } from './mcp.js'

// `isorun-mcp`: serve the Isorun MCP tools over stdio. Point any MCP client
// (Claude Desktop, Cursor, Zed) at this binary with ISORUN_API_KEY in env.
const server = await buildServer()
await server.connect(new StdioServerTransport())
