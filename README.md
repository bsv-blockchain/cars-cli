# CARS CLI — Cloud Automated Runtime System

The **CARS CLI** (`cars`) is a command-line interface for deploying and managing BSV Blockchain-based Overlay Services in production cloud environments. It builds on concepts you may know from LARS (Local Automated Runtime System) and OverlayExpress, making it easy to go from local development to cloud deployment.

## Overview

CARS enables you to:

- **Create and manage multiple deployment configurations** directly from your project's `deployment-info.json`.
- **Build and deploy your BSV project** (including frontend and backend components) to a CARS-enabled cloud environment.
- **Manage projects, admins, and releases** remotely with simple CLI commands.
- **Interactively configure and operate** if no arguments are supplied, guiding you through the setup process.

## Key Features

- **Interactive Menus**: Running `cars` without arguments launches an interactive menu system for easy navigation.
- **Multiple Configurations in One File**: All configurations and deployment targets are stored in `deployment-info.json` at your project root.
- **Automated Builds**: The `cars build` command compiles and packages your backend, frontend, and configuration into a single deployable artifact.
- **Seamless Deployments**: Quickly create new releases, get secure upload URLs, and deploy artifacts to the cloud.
- **Project Management**: Administer projects, add/remove admins, and view logs all through the CLI.

## Installation

Install the CARS CLI globally with:

```bash
npm install -g @bsv/cars-cli
```

After installation, the `cars` command is available system-wide.

## Prerequisites

- A **BSV Project** structured similarly to what LARS/OverlayExpress expect. Typically:
  - `deployment-info.json` in the project root.
  - `backend/` directory for backend code (Topic Managers, Lookup Services).
  - `frontend/` directory for frontend code (optional).
  
- A **CARS Cloud** environment URL provided by your hosting service or a local CARS server (e.g., `http://localhost:7777`).

## Getting Started

### 1. Initialize Your Environment

Make sure your project has a `deployment-info.json`. If not, create one according to the [OverlayExpress schema](https://github.com/tonicpow/overlayexpress) and place it at the root.

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

CARS uses BSV Auth for authentication. The first request you make to a new CARS Cloud may prompt registration. The CLI handles this automatically. Once registered, your identity is remembered so you can administer projects and deploy seamlessly.

### 4. Building an Artifact

Before you deploy, you need to build a deployable artifact. From your project root (where `deployment-info.json` is):

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

### 5. Creating a Project (If Needed)

If you didn't create a project when adding the config, you can do so through the interactive `cars` menu under **"Manage Projects"**, or via:

```bash
cars project
```

Then select the appropriate actions.  
If you have multiple configurations, you’ll be prompted to choose one or create a new project for your chosen CARS config.

### 6. Deploying Your Artifact

You have two main options:

**Option A: Deploy Immediately**

If you've just built an artifact and want to deploy it now, run:

```bash
cars release now
```

Select the configuration if prompted, and the CLI will:

- Create a new release (deployment) on the CARS Cloud.
- Automatically upload your latest artifact.

**Option B: Get an Upload URL First**

If you want to separate the steps (e.g., CI/CD pipelines):

```bash
cars release get-upload-url
```

This returns a `deploymentId` and a signed `uploadURL`. Then you can upload the artifact manually:

```bash
cars release upload-files <uploadURL> <path-to-artifact>
```

### 7. Managing Projects and Admins

You can list projects, manage admins, and view logs:

```bash
cars project ls
cars project add-admin <identityKey>
cars project remove-admin <identityKey>
cars project list-admins
cars project logs
```

Follow the interactive prompts if not specifying arguments.  

### 8. Viewing Releases and Logs

List releases for your project:

```bash
cars project releases
```

View logs for a specific release:

```bash
cars release logs <releaseId>
```

If you don’t provide a `releaseId`, you’ll be prompted to choose one.

## Command Reference

**Main Command (Interactive)**  
- **`cars`**  
  Running `cars` with no arguments opens an interactive menu-driven interface for all actions. Ideal for first-time usage.

**Configuration Commands** (Manage `deployment-info.json` configs)  
- **`cars config`** (no args) : Interactive config menu.  
- **`cars config ls`** : List all configurations (CARS and others).  
- **`cars config add`** : Add a new CARS configuration interactively.  
- **`cars config edit <nameOrIndex>`** : Edit an existing CARS configuration.  
- **`cars config delete <nameOrIndex>`** : Delete a CARS configuration.

**Build Command**  
- **`cars build`** : Builds a `.tgz` artifact from your project.

**Project Management Commands**  
- **`cars project`** : Interactive project menu.  
- **`cars project ls`** : List all projects where you’re an admin.  
- **`cars project add-admin <identityKey>`** : Add an admin to the selected project.  
- **`cars project remove-admin <identityKey>`** : Remove an admin from the selected project.  
- **`cars project list-admins`** : List all admins of the selected project.  
- **`cars project logs`** : Show logs for the selected project.  
- **`cars project releases`** : List all releases (deployments) for the selected project.

**Release Management Commands**  
- **`cars release`** : Interactive release menu.  
- **`cars release get-upload-url`** : Create a new release and return an upload URL.  
- **`cars release upload-files <uploadURL> <artifactPath>`** : Upload artifact to a previously obtained URL.  
- **`cars release logs [releaseId]`** : View logs of a given release (prompted if `releaseId` not provided).  
- **`cars release now`** : Create and upload a new release using the latest artifact in one step.

**Artifact Management Commands**  
- **`cars artifact`** : Interactive artifact menu.  
- **`cars artifact ls`** : List all local artifacts.  
- **`cars artifact delete <artifactName>`** : Delete a specified local artifact.

## Tips & Advanced Usage

- **Interactive Menus**: If you ever feel unsure about what to do next, just run `cars` without arguments and follow the menus.
- **Multiple CARS Configs**: You can store several CARS configurations in one `deployment-info.json` (e.g., staging and production). The CLI will prompt you to pick which to use for each operation.
- **Continuous Integration**:  
  Add `cars build` and `cars release now` or `cars release get-upload-url && cars release upload-files ...` steps to your CI pipeline for automatic deployments on every commit.
- **Logs and Troubleshooting**:  
  Use `cars project logs` and `cars release logs` to investigate any issues in deployments.

## License

[Open BSV License](./LICENSE.txt)