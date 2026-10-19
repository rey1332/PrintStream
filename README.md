# PrintStream

By ETNA : Enterprise Transformation & Intelligence Architecture**

PrintStream brings business data and workflows into one controlled workspace. Today, it includes business modules for areas like finance, inventory, HR, and operations, alongside tools for data analysis and automation.

The longer term goal is to help companies connect data across their systems. General-purpose integrations with external ERPs and data sources are still in development.

# What it does today

- Manage business data across workspaces with role-based access.
- Use modules for sales, purchasing, inventory, accounting, HR, payroll, and selected       operational workflows.
- Search and analyze supported business data through a shared data model.
- Build visual pipelines for datasets, imports, transformations, and scheduled jobs.
- Track changes and access through audit logs.

# What’s still in progress

PrintStream is stil in evolving stage. Some parts of the broader vision are not built yet:

- General integrations for external ERPs, databases, APIs, and files.
- Wider analytics coverage for operational data.
- Machine learning pipelines.
- Sandboxed execution of user-written code.

See the [project documentation](docs/) for current feature details and limitations.

# How it works

The browser talks to the PrintStream server, which checks the user’s session and permissions before accessing PostgreSQL. The database enforces workspace access rules and records relevant changes.
