# Contributing to Godot MCP

Thank you for considering contributing to Godot MCP! This document outlines the process for contributing to the project.

## Code of Conduct

By participating in this project, you agree to maintain a respectful and inclusive environment for everyone.

## How Can I Contribute?

### Reporting Bugs

- Check if the bug has already been reported in the Issues section
- Use the bug report template if available
- Include detailed steps to reproduce the bug
- Include any relevant logs or screenshots
- Specify your environment (OS, Godot version, etc.)

### Suggesting Enhancements

- Check if the enhancement has already been suggested in the Issues section
- Use the feature request template if available
- Clearly describe the enhancement and its benefits
- Consider how the enhancement fits into the project's scope

### Pull Requests

1. Fork the repository
2. Create a new branch for your feature or bugfix (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests if available
5. Commit your changes with clear commit messages
6. Push to your branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

## Development Process

### Setting Up the Development Environment

You need **Node.js 22.18 or newer** for development: the tests and helper scripts run TypeScript files directly. (The built server itself runs on Node 20+.)

1. Clone the repository
2. Install dependencies with `npm install`
3. Build the project with `npm run build`
4. For development with auto-rebuild, use `npm run watch`
5. Run `npm test` (requires Godot 4.5+; set `GODOT_PATH`). The integration tests run against the built server (`npm run test:integration` builds it first; build again before running a single test file).
6. After changing a tool's description or input schema, run `npm run docs:tools` to regenerate `docs/mcp-tools.md`.

### Project Structure

```
godot-mcp/
├── src/                    # TypeScript MCP server
│   ├── index.ts            # entry point (serveStdio)
│   ├── server.ts           # McpServer factory
│   ├── context.ts          # process-wide state, locks, write guards
│   ├── security/           # path canonicalisation and project boundaries
│   ├── godot/              # locate, process runner, worker, runtime, diagnostics
│   ├── editor/             # editor-bridge client
│   ├── tools/              # one module per tool family (+ legacy adapters)
│   └── resources/          # godot:// MCP resources
├── godot/
│   ├── worker/             # headless MainLoop worker + op modules + capture runner
│   └── addons/godot_mcp/   # editor plugin + shared GDScript lib
├── test/                   # unit + real-Godot integration tests (node --test)
├── docs/                   # architecture, security, coverage, testing, audits
└── scripts/                # build, docs generation, benchmark
```

See [docs/architecture.md](docs/architecture.md) and [docs/testing.md](docs/testing.md). Every new tool or action needs an integration test against real Godot, and `npm run docs:tools` must be re-run.

### Code Style

- Follow the existing code style in the project
- Use TypeScript for type safety
- Include JSDoc comments for all functions and classes
- Write clear and descriptive variable and function names
- Use meaningful interfaces for complex objects
- Handle errors gracefully with detailed error messages

### Debugging

For debugging the MCP server:

1. Set the `DEBUG` environment variable to `true`
2. Use the MCP Inspector for interactive debugging:
   ```bash
   npm run inspector
   ```
3. Check the logs for detailed information about what's happening

### Adding New Tools

When adding new tools to the MCP server:

1. Define the tool in the `setupToolHandlers` method
2. Create a handler method for the tool
3. Add proper input validation and error handling
4. Update the README.md with documentation for the new tool
5. Update the Features section in the README.md
6. Update the autoApprove section in the configuration examples
7. Add tests for the new functionality

#### Recently Added Tools

The following tools have been recently added:

- **get_project_info**: Retrieves metadata about a Godot project
  - Analyzes project structure
  - Returns information about scenes, scripts, and assets
  - Helps LLMs understand the organization of Godot projects
  
- **capture_screenshot**: Takes a screenshot of a running Godot project
  - Requires an active Godot process
  - Saves the screenshot to the specified path
  - Useful for visual debugging and feedback

Example:

```typescript
// In setupToolHandlers
{
  name: 'your_new_tool',
  description: 'Description of what your tool does',
  inputSchema: {
    type: 'object',
    properties: {
      param1: {
        type: 'string',
        description: 'Description of parameter 1',
      },
    },
    required: ['param1'],
  },
}

// Add handler method
private async handleYourNewTool(args: any) {
  // Validate input
  if (!args.param1) {
    return this.createErrorResponse(
      'Parameter 1 is required',
      ['Provide a valid value for parameter 1']
    );
  }

  try {
    // Implement tool functionality
    // ...

    return {
      content: [
        {
          type: 'text',
          text: 'Result of your tool',
        },
      ],
    };
  } catch (error: any) {
    return this.createErrorResponse(
      `Failed to execute tool: ${error?.message || 'Unknown error'}`,
      [
        'Possible solution 1',
        'Possible solution 2'
      ]
    );
  }
}
```

### Cross-Platform Compatibility

When making changes, ensure they work across different platforms:

- Use path utilities from Node.js (`path.join`, etc.) instead of hardcoded path separators
- Test on different operating systems if possible
- Consider different Godot installation locations
- Use environment variables for configuration

## Testing

- Add tests for new features when possible
- Ensure all tests pass before submitting a Pull Request
- Test on different platforms if possible
- Test with different Godot versions

## Documentation

- Keep README.md up to date with new features
- Document all tools and their parameters
- Include examples for new functionality
- Update the troubleshooting section with common issues

## Questions?

If you have any questions about contributing, feel free to open an issue for discussion.

Thank you for your contributions!
