
# ETNA PrintStream

**Version 1.0.1** by ETNA  
*Enterprise Transformation & Intelligence Architecture*

PrintStream brings your company's operations and data together in one place.

Manage sales, purchasing, inventory, accounting, tax, HR, and payroll while working with the datasets, pipelines, charts, and SQL tools that help you understand your business.

PrintStream runs on our server, giving you control over your infrastructure and how your data is managed.

**Documentation:** [Indonesian User Guide](docs/PANDUAN.md) · [Technical Documentation](docs/teknis/)

## What is PrintStream?

Business data often ends up scattered across ERP systems, spreadsheets, databases, and disconnected tools. Getting a clear answer means exporting files, combining data, and hoping everything matches.

PrintStream brings these workflows closer together. You can manage daily operations, connect data from different sources, build reusable pipelines, and explore results without constantly switching between tools.

The goal is simple: spend less time moving data around and more time putting it to use.

## Features

### Business Operations

Manage everyday business processes through a single platform.

• Sales, purchasing, inventory, accounting, tax, HR, and payroll modules.

• Multiple company workspaces on one server, with access controls for each workspace.

• Built in roles for Owners, Admins, and Finance, with support for custom permissions.

• A dashboard for monitoring revenue, receivables, and business trends.

### Data & Analytics

Bring your data together and make it easier to work with.

• Import files and connect databases and APIs.

• Organize imported information into reusable datasets.

• Build visual pipelines with filtering, joins, aggregation, and pivot operations.

• Create visualizations using twelve chart types, including bar, line, area, scatter, histogram, heatmap, and pivot tables.

• Use the SQL Query Tool when you need more direct control over your data.

• Run optional JavaScript transformations for custom logic, scoring, and data cleaning inside a restricted sandbox.

### AI Integration

Connect AI assistants to your data workflows through the Model Context Protocol (MCP).

• Connect Claude and other compatible assistants.

• Let assistants inspect datasets, profile data, and draft pipelines through supported tools.

• Choose which tools and datasets each connection can access.

• Keep JavaScript code execution outside the capabilities granted to AI assistants.

### Security & Control

Your business data deserves more than a login screen.

• Password authentication and two factor authentication (2FA).

• Additional verification for sensitive actions.

• Audit logs for important system changes.

• Application permissions backed by PostgreSQL Row Level Security (RLS).

• Self hosted infrastructure that keeps deployment and data storage under your control.

### Deployment & Recovery

Run PrintStream on infrastructure you manage.

• Production installation on Ubuntu Server.

• Windows support for development.

• Command line management through `psctl`.

• Tools for backups, encrypted off site copies, restoration, and server migration.

• Horizontal scaling: add application servers that share one database and the data folder, with Cloudflare Tunnel spreading visitors across them ([guide](docs/teknis/CLUSTER.md)).

## Architecture

```text
Browser
   |
   v
PrintStream App
   |
   +---- PostgreSQL
   |       Row Level Security
   |
   +---- Worker
   |       Imports, pipelines, schedules
   |
   +---- Data Folder
           Documents and uploaded files
```

The application checks user permissions before allowing access to resources. PostgreSQL adds another layer of protection through Row Level Security, helping keep company workspaces separated.

## Getting Started

| Environment | Guide |
|---|---|
| Ubuntu Server | [Production installation](docs/PANDUAN.md#3-pasang-di-ubuntu-server-untuk-dipakai-kantor) |
| Windows | [Development setup](docs/PANDUAN.md#4-pasang-di-windows-pc-development) |
| Updating PrintStream | [Update guide](docs/PANDUAN.md#6-update-ke-versi-baru) |
| Technical documentation | [Technical reference](docs/teknis/) |

**Built with:** Next.js, Node.js, and PostgreSQL.

PrintStream is designed to run on your own infrastructure without requiring a managed cloud platform for its core application and database.

## What's New in 1.0.1

• Added a chart node with twelve visualization types for data pipelines.

• Added optional sandboxed JavaScript transformations with owner controlled activation and audit logging.

• Added configurable MCP permissions for individual connections.

• Updated the ERP dashboard layout to make better use of available space.

## What's Next

PrintStream is still evolving. Some areas we want to develop further include:

• Ready made connectors for external ERP systems.

• Machine learning for forecasting and anomaly detection.

• More tools for data intelligence and business automation.

## License

Proprietary software. Copyright © 2026 ETNA.

All rights reserved. See [LICENSE](LICENSE) for the applicable terms.
