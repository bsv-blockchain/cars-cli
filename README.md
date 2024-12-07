# CARS CLI — Cloud Automated Runtime System

The **CARS CLI** (`cars`) is a command-line interface for deploying and managing BSV Blockchain-based Overlay Services in production cloud environments. It extends the concepts used locally by LARS (Local Automated Runtime System) to a scalable cloud platform, enabling developers to seamlessly deploy Topic Managers, Lookup Services, and related BSV project components to the cloud.

CARS integrates with cloud-based hosting providers that run an OverlayExpress environment, managing your `deployment-info.json` configuration, building artifacts, and deploying them to a remote runtime environment. This process is similar in spirit to how Netlify or Vercel works for web applications, but specialized for BSV Overlay Services.

## Key Features

- **Cloud-based Deployments**: Push local BSV projects to a configured CARS cloud provider.
- **Automated Builds**: Compiles Topic Managers, Lookup Services, and optionally frontend code to a deployable artifact.
- **Unified Configurations**: Manage multiple cloud deployment targets and easily switch between them.
- **Project Management**: Create, configure, and manage projects and deployments directly from the CLI.
- **Continuous Improvements**: Integrates easily into existing CI/CD pipelines and developer workflows.

## Installation

You can install the CARS CLI globally using NPM:

```bash
npm install -g @bsv/cars-cli
```

This will make the `cars` command available system-wide.

## Prerequisites

- **BSV Project Structure**: Your project should conform to the `deployment-info.json` schema used by LARS and OverlayExpress.  

## Getting Started

### 1. Create a CARS Configuration

First, you need to create a configuration profile for your desired cloud environment. This stores settings like the CARS Cloud URL and defaults.

```bash
cars config create
```

You will be prompted to select a cloud URL and optional defaults. After creation, a configuration is stored in `~/.cars-config.json`. If you have multiple profiles, you can switch between them using:

```bash
cars config activate <profileName>
```

### 2. Prepare Your Project

Ensure your project includes a `deployment-info.json` file and follows the standard BSV project structure (as used by LARS):

- `backend/` directory with your Topic Managers and Lookup Services.
- `frontend/` directory if you have a user interface.
- `deployment-info.json` at the project root, referencing topic managers, lookup services, etc.

### 3. Build Your Artifact

From within your project's root directory (where `deployment-info.json` lives):

```bash
cars build
```

This command:

- Installs dependencies (backend/frontend).
- Compiles contracts and code as necessary.
- Produces a compressed artifact (`.tgz`) for deployment.

### 4. Create a Project on the Cloud

If you haven't created a project in the CARS cloud environment yet:

```bash
cars project create
```

This will return information about the created project, including a `projectId`.

**Note**: You must have an active configuration and be authenticated.

### 5. Deploy Your Artifact to the Project

Deploy your latest built artifact to the cloud:

```bash
cars deploy <projectId>
```

This retrieves an upload URL and posts your artifact to the CARS cloud, initiating the deployment process.

### 6. Check Logs and Deployment Status

You can view logs for your project and deployments:

```bash
cars project logs <projectId>
cars deploy logs <deploymentId>
```

Use these commands to troubleshoot and monitor deployments.

## Commands Reference

**Configuration Commands**

- **`cars config create [name]`**  
  Create a new configuration profile. Prompts for cloud URL and preferences if no arguments are given.

- **`cars config list`**  
  Lists all configuration profiles.

- **`cars config activate <name>`**  
  Activates a previously created configuration profile.

- **`cars config edit <name>`**  
  Edit an existing configuration profile (e.g., change the cloud URL, defaults).

- **`cars config delete <name>`**  
  Delete a configuration profile.

- **`cars config get <key>`**  
  Get a value from the active configuration. Valid keys: `cloudUrl`, `defaultProjectId`, `defaultProjectDir`, `autoSetProjectId`.

- **`cars config set <key> <value>`**  
  Set a value in the active configuration.  
  Example: `cars config set defaultProjectId my-project-123`

- **`cars config reset`**  
  Reset (delete) all configurations.

**Build and Artifact Commands**

- **`cars build`**  
  Builds a local artifact (`.tgz`) from your project. Installs dependencies, compiles code, and packages `backend/`, `frontend/`, and `deployment-info.json`.

**Project Commands**

- **`cars project create`**  
  Create a new project in the CARS cloud. Returns a `projectId` that you can use for deployments.

- **`cars project ls`**  
  List all projects you administer.

- **`cars project add-admin <projectId> <identityKey>`**  
  Add a new admin user (by identity key) to a project.

- **`cars project remove-admin <projectId> <identityKey>`**  
  Remove an existing admin from a project.

- **`cars project logs <projectId>`**  
  Show logs for the specified project.

- **`cars project deploys <projectId>`**  
  List all deployments for a given project.

**Deployment Commands**

- **`cars deploy <projectId>`**  
  Creates a new deployment for `projectId` and uploads the latest artifact.

- **`cars deploy get-upload-url <projectId>`**  
  Get a new deployment upload URL without immediately uploading. Useful if you want to handle the upload separately.

- **`cars deploy upload-files <uploadURL> <artifactPath>`**  
  Upload an artifact to a previously obtained `uploadURL`. This is a low-level command, typically `cars deploy <projectId>` is simpler.

- **`cars deploy logs <deploymentId>`**  
  View logs of a specific deployment.

## Advanced Usage

**Auto-Setting Project IDs**:  
If `autoSetProjectId` is enabled in your config and `defaultProjectDir` matches your current directory, the CLI can remember the last used `projectId` for that directory. This helps streamline repeated deployments without needing to specify the `projectId` each time.

**Multiple Configurations**:  
You can create multiple configurations for different cloud environments (e.g., `staging`, `production`) and switch between them with `cars config activate`.

**Continuous Integration**:  
Integrate `cars build` and `cars deploy <projectId>` into your CI workflows to automatically build and deploy on every commit or tag.

## Troubleshooting

- **No Active Config**: If you receive an error about no active configuration, run `cars config create` or `cars config activate <name>`.
- **No `deployment-info.json`**: Ensure your project is structured correctly and includes a `deployment-info.json` at the root.

CARS CLI provides a production-grade environment to host your BSV Overlay Services. By marrying the local convenience of LARS with the scalability and availability of the cloud, CARS helps you focus on building and iterating on your BSV-based apps, while it takes care of deployments and runtime management.

## License

[Open BSV License](./LICENSE.txt)