# CARS CLI — Cloud Automated Runtime System

The **CARS CLI** (`cars`) is a command-line interface for deploying and managing BSV Blockchain-based Overlay Services in production cloud environments. It builds on concepts you may know from LARS (Local Automated Runtime System) and OverlayExpress, streamlining the transition from local development to cloud deployment.

## Overview

CARS enables you to:

- **Create and manage multiple deployment configurations** directly in your project's `deployment-info.json`.
- **Build and deploy your entire BSV project** (frontend and backend) to a CARS-enabled cloud.
- **Manage projects, admins, and releases** either interactively or through direct CLI commands for scriptable, non-interactive workflows.
- **View detailed logs:** Project-level logs, release (deployment) logs, and resource-level logs from the running environment.
- **Set custom domains, manage billing, and configure Web UI parameters** directly from the CLI.
- **Configure advanced engine options** (e.g., sync configuration, request logging, GASP on/off, etc.) **and trigger admin-protected endpoints** (e.g. `syncAdvertisements`, `startGASPSync`) on your deployed OverlayExpress instance through your CARS Cloud.

## Key Features

- **Interactive Menus**: Running `cars` with no arguments launches an interactive menu system to guide you step-by-step.
- **Comprehensive CLI Commands**: Every action you can perform interactively is also available as a direct CLI subcommand, enabling non-interactive automation and CI/CD integration.
- **Automated Builds**: `cars build` compiles and packages backend, frontend, and configuration into a deployable artifact.
- **Seamless Deployments**: Quickly create new releases, get secure upload URLs, and deploy artifacts to the CARS Cloud.
- **Advanced Project Management**: Add/remove project admins, top up balance, set custom domains, and adjust Web UI configurations.
- **Rich Logging**: View logs at multiple levels (project, release, resource), with filtering options for easy debugging.
- **Fine-Grained Engine Control**: Edit advanced engine configurations (sync settings, log toggles, broadcast options) and **invoke admin endpoints** for your deployed OverlayExpress services.

## Installation

Install the CARS CLI globally:

```bash
npm install -g @bsv/cars-cli
```

Once installed, the `cars` command is available system-wide.

## Prerequisites

- A **BSV Project** structured similarly to what LARS/OverlayExpress expect. Typically:
  - `deployment-info.json` in the project root.
  - `backend/` directory for backend code (Topic Managers, Lookup Services).
  - `frontend/` directory for frontend code (optional).
  
- A **CARS Cloud** environment URL (e.g., `http://localhost:7777` or a production URL provided by your hosting service).

## Getting Started

### 1. Initialize Your Environment

Make sure your project has a `deployment-info.json`. If not, create one according to the [BSV Project Schema](https://github.com/bitcoin-sv/BRCs/blob/master/apps/0102.md) and place it at the root.

If you run `cars` in a directory without a `deployment-info.json`, the CLI will help you create a basic one.

### 2. Create a CARS Configuration

Run `cars` with no arguments:

```bash
cars
```

This will open an interactive menu if `deployment-info.json` is found. If you have no CARS configurations, the CLI will guide you through creating one:

- **Choose a CARS Cloud URL** (e.g. `http://localhost:7777` or a production URL).
- **Create or select a Project ID** on that CARS Cloud (you can create a new one directly).
- **Configure which parts of your project to deploy** (e.g., `frontend`, `backend`).

You can also explicitly create a new CARS configuration anytime:

```bash
cars config add
```

This prompts you for the configuration details and updates `deployment-info.json`.

### 3. Register Your Identity

The first interaction with a new CARS Cloud triggers an identity registration. The CLI handles this automatically. Once registered, your credentials are stored, enabling admin actions without re-prompting.

### 4. Build a Deployable Artifact

Compile your project into an artifact:

```bash
cars build
```

This command:

- Installs and builds dependencies for `backend/` and `frontend/`.
- Packages everything into a `.tgz` artifact in the current directory.

You can list your local artifacts with:

```bash
cars artifact ls
```

### 5. Create or Select a Project

If you didn’t create a project earlier, do so now:

Interactive:
```bash
cars
```
Navigate to "Manage Projects" and follow the prompts.

Non-interactive:
```bash
cars project ls
cars project info
# ...or
cars project
```
You’ll be prompted to choose a configuration if multiple exist.

### 6. Deploy Your Artifact

**Option A: Quick Deploy**

```bash
cars release now
```

This automatically creates a new release and uploads your latest artifact in one go.

**Option B: Manual Steps**

1. Get an upload URL:
   ```bash
   cars release get-upload-url
   ```
   This returns a `deploymentId` and `uploadURL`.

2. Upload your artifact:
   ```bash
   cars release upload-files <uploadURL> <path-to-artifact>
   ```

### 7. Managing Projects, Admins, and Domains

Interactive:
```bash
cars
```
Go to "Manage Projects" and pick the desired action.

Non-interactive examples:
```bash
cars project ls
cars project info
cars project add-admin <identityKeyOrEmail>
cars project remove-admin <identityKeyOrEmail>
cars project list-admins
cars project domain:frontend example.com
cars project domain:backend api.example.com
cars project webui-config:view
cars project webui-config:set MY_KEY "my value"
cars project webui-config:delete MY_KEY
cars project billing-stats --start 2024-01-01 --end 2024-01-31 --type debit
cars project topup --amount 100000
```

You can even delete a project:
```bash
cars project delete
```
(Requires confirmation or `--force` options.)

### 8. Viewing Logs

- **Project Logs:**
  ```bash
  cars project logs
  ```

- **Resource-Level Logs (frontend/backend/mongo/mysql):**
  ```bash
  cars project resource-logs --resource backend --since 1h --tail 500 --level error
  ```

- **Release (Deployment) Logs:**
  ```bash
  cars release logs <releaseId>
  ```
  If `<releaseId>` not provided, you’ll be prompted or can select interactively.

### 9. Advanced Engine Configuration and Admin Endpoints

You can edit advanced engine parameters (e.g., GASP on/off, sync configuration, request logging, log prefix, broadcast-failure handling) via the CLI:

```bash
cars
```
Under "Manage Projects" > "Edit Advanced Engine Config", you can **toggle** these options or **edit** your sync configuration.

You can also **trigger admin-protected endpoints** on your deployed OverlayExpress service:

- **syncAdvertisements**:
  ```bash
  cars
  ```
  Then select "Trigger admin syncAdvertisements" under the Project Management menu.

- **startGASPSync**:
  Similarly, choose "Trigger admin startGASPSync" from the Project Management menu.

These endpoints securely proxy your request through the CARS Node using your project’s admin bearer token.

### 10. Global Public Info

View global public info about the selected CARS Cloud (public keys, pricing):

```bash
cars global-info
```

## Command Reference

**Main Command (Interactive)**  
- **`cars`**  
  Launches an interactive menu system if run without arguments.

**Configuration Management**  
- **`cars config`** : Interactive config menu.  
- **`cars config ls`** : List all configurations.  
- **`cars config add`** : Add a new CARS configuration interactively.  
- **`cars config edit <nameOrIndex>`** : Edit an existing CARS configuration.  
- **`cars config delete <nameOrIndex>`** : Delete a CARS configuration.

**Build**  
- **`cars build [nameOrIndex]`** : Build a `.tgz` artifact. If multiple configs, pick one.

**Project Management**  
- **`cars project`** : Interactive project menu.  
- **`cars project ls [nameOrIndex]`** : List all projects for the chosen CARS Cloud.  
- **`cars project info [nameOrIndex]`** : Show detailed project info.  
- **`cars project add-admin <identityKeyOrEmail> [nameOrIndex]`** : Add an admin.  
- **`cars project remove-admin <identityKeyOrEmail> [nameOrIndex]`** : Remove an admin.  
- **`cars project list-admins [nameOrIndex]`** : List all admins.  
- **`cars project logs [nameOrIndex]`** : Show project-level logs.  
- **`cars project resource-logs [nameOrIndex]`** : Show resource-level logs with `--resource`, `--since`, `--tail`, `--level` options.  
- **`cars project releases [nameOrIndex]`** : List all releases of the project.  
- **`cars project domain:frontend <domain> [nameOrIndex]`** : Set the frontend domain.  
- **`cars project domain:backend <domain> [nameOrIndex]`** : Set the backend domain.  
- **`cars project webui-config:view [nameOrIndex]`** : View Web UI config.  
- **`cars project webui-config:set <key> <value> [nameOrIndex]`** : Set a config key.  
- **`cars project webui-config:delete <key> [nameOrIndex]`** : Delete a config key.  
- **`cars project billing-stats [nameOrIndex]`** : View billing stats, with `--start`, `--end`, `--type`.  
- **`cars project topup [nameOrIndex]`** : Top up project balance, optional `--amount`.  
- **`cars project delete [nameOrIndex]`** : Delete project (confirmation required, or use `--force`).

**Release Management**  
- **`cars release`** : Interactive release menu.  
- **`cars release get-upload-url [nameOrIndex]`** : Create a new release and get upload URL.  
- **`cars release upload-files <uploadURL> <artifactPath>`** : Upload artifact.  
- **`cars release logs [releaseId] [nameOrIndex]`** : View release logs; if no `releaseId`, prompts for one.  
- **`cars release now [nameOrIndex]`** : Create and immediately upload the latest artifact.

**Artifact Management**  
- **`cars artifact`** : Interactive artifact menu.  
- **`cars artifact ls`** : List local artifacts.  
- **`cars artifact delete <artifactName>`** : Delete a local artifact.

**Global Info**  
- **`cars global-info [nameOrIndex]`** : View public keys, pricing, etc. for a chosen CARS Cloud.

## Tips & Best Practices

- Start interactively with `cars` to get a feel for the process, then switch to direct subcommands as you grow comfortable.
- Use multiple CARS configurations in `deployment-info.json` for different environments (e.g. staging vs production).
- Integrate commands like `cars build` and `cars release now` into CI/CD pipelines for continuous deployment.
- Use `cars project resource-logs` and `cars release logs` for debugging runtime issues.

## License

[Open BSV License](./LICENSE.txt)