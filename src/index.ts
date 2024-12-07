#!/usr/bin/env node
import { program } from 'commander';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import ora from 'ora';
import * as tar from 'tar';
import os from 'os';
import { spawnSync } from 'child_process';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { AuthriteClient } from 'authrite-js';

interface DeploymentInfo {
    schema: string;
    schemaVersion: string;
    topicManagers?: Record<string, string>;
    lookupServices?: Record<string, { serviceFactory: string; hydrateWith?: string }>;
    frontend?: { language: string; sourceDirectory: string };
    contracts?: { language: string; baseDirectory: string };
}

interface CarsConfigProfile {
    name: string;
    cloudUrl: string;
    defaultProjectId?: string;
    defaultProjectDir?: string;
    autoSetProjectId?: boolean;
}

interface CarsConfigsFile {
    activeConfigName?: string;
    configs: CarsConfigProfile[];
}

const CARS_CONFIG_PATH = path.resolve(os.homedir(), '.cars-config.json');

//
// Utility functions for config management
//

function loadConfigsFile(): CarsConfigsFile {
    if (!fs.existsSync(CARS_CONFIG_PATH)) {
        return { configs: [] };
    }
    return JSON.parse(fs.readFileSync(CARS_CONFIG_PATH, 'utf-8'));
}

function saveConfigsFile(configsFile: CarsConfigsFile) {
    fs.writeFileSync(CARS_CONFIG_PATH, JSON.stringify(configsFile, null, 2));
}

function deleteConfigFile() {
    if (fs.existsSync(CARS_CONFIG_PATH)) {
        fs.rmSync(CARS_CONFIG_PATH);
    }
}

function getActiveConfig(): CarsConfigProfile | undefined {
    const configsFile = loadConfigsFile();
    if (!configsFile.activeConfigName) return undefined;
    return configsFile.configs.find(c => c.name === configsFile.activeConfigName);
}

async function requireActiveConfig(interactive = false): Promise<CarsConfigProfile> {
    let activeConfig = getActiveConfig();
    if (!activeConfig) {
        if (!interactive) {
            console.error('No active configuration found. Run `cars config create` or `cars config activate <name>` first.');
            process.exit(1);
        }
        // Prompt user to create one if none exists
        if (loadConfigsFile().configs.length === 0) {
            console.log('No configurations found. Let’s create one.');
            await createConfigInteractive();
        } else {
            console.log('No active configuration selected. Please activate a configuration using `cars config activate <name>`.');
            process.exit(1);
        }
        activeConfig = getActiveConfig();
        if (!activeConfig) {
            console.error('No active configuration after creation. Exiting.');
            process.exit(1);
        }
    }
    // Ensure registration with the current cloud URL
    await ensureRegistered(activeConfig);
    return activeConfig;
}

async function ensureRegistered(config: CarsConfigProfile) {
    const client = new AuthriteClient(config.cloudUrl);
    try {
        await client.createSignedRequest('/api/v1/register', {});
    } catch (error: any) {
        console.error(`Failed to register with CARS Cloud at ${config.cloudUrl}.`);
        console.error(error.response?.data || error.message);
        process.exit(1);
    }
}

function updateActiveConfig(updatedConfig: CarsConfigProfile) {
    const configsFile = loadConfigsFile();
    const idx = configsFile.configs.findIndex(c => c.name === updatedConfig.name);
    if (idx === -1) {
        console.error('Active config not found while updating.');
        process.exit(1);
    }
    configsFile.configs[idx] = updatedConfig;
    saveConfigsFile(configsFile);
}

function setActiveConfig(name: string) {
    const configsFile = loadConfigsFile();
    const config = configsFile.configs.find(c => c.name === name);
    if (!config) {
        console.error(`Configuration with name "${name}" not found.`);
        process.exit(1);
    }
    configsFile.activeConfigName = name;
    saveConfigsFile(configsFile);
}

async function createConfigInteractive(name?: string) {
    const configsFile = loadConfigsFile();
    if (!name) {
        name = await generateUniqueConfigName(configsFile);
    }

    const cloudChoices = [
        { name: 'localhost:7777', value: 'http://localhost:7777' },
        { name: 'cars-cloud1.com', value: 'https://cars-cloud1.com' },
        { name: 'cars-cloud2.com', value: 'https://cars-cloud2.com' },
        { name: 'cars-cloud3.com', value: 'https://cars-cloud3.com' },
        { name: 'Custom', value: 'custom' }
    ];

    const answers = await inquirer.prompt([
        {
            type: 'list',
            name: 'cloudUrlChoice',
            message: 'Select a CARS Cloud URL:',
            choices: cloudChoices
        },
        {
            type: 'input',
            name: 'customCloudUrl',
            message: 'Enter custom CARS Cloud URL:',
            when: (ans) => ans.cloudUrlChoice === 'custom',
            default: 'http://localhost:7777'
        },
        {
            type: 'confirm',
            name: 'autoSetProjectId',
            message: 'Auto-set project ID for this config based on directory when building and deploying?',
            default: true
        }
    ]);

    const finalCloudUrl = answers.cloudUrlChoice === 'custom' ? answers.customCloudUrl : answers.cloudUrlChoice;

    const newConfig: CarsConfigProfile = {
        name,
        cloudUrl: finalCloudUrl,
        autoSetProjectId: answers.autoSetProjectId
    };

    configsFile.configs.push(newConfig);
    // If no active config, set this one as active
    if (!configsFile.activeConfigName) {
        configsFile.activeConfigName = name;
    }
    saveConfigsFile(configsFile);

    // Attempt registration
    await ensureRegistered(newConfig);

    console.log(`Configuration "${name}" created and activated.`);
}

async function editConfigInteractive(name: string) {
    const configsFile = loadConfigsFile();
    const config = configsFile.configs.find(c => c.name === name);
    if (!config) {
        console.error(`No configuration named "${name}" found.`);
        process.exit(1);
    }

    const cloudChoices = [
        { name: 'localhost:7777', value: 'http://localhost:7777' },
        { name: 'cars-cloud1.com', value: 'https://cars-cloud1.com' },
        { name: 'cars-cloud2.com', value: 'https://cars-cloud2.com' },
        { name: 'cars-cloud3.com', value: 'https://cars-cloud3.com' },
        { name: 'Custom', value: 'custom' }
    ];

    const currentCloudChoice = cloudChoices.find(ch => ch.value === config.cloudUrl) ? config.cloudUrl : 'custom';

    const answers = await inquirer.prompt([
        {
            type: 'list',
            name: 'cloudUrlChoice',
            message: 'Select a CARS Cloud URL:',
            choices: cloudChoices,
            default: currentCloudChoice
        },
        {
            type: 'input',
            name: 'customCloudUrl',
            message: 'Enter custom CARS Cloud URL:',
            when: (ans) => ans.cloudUrlChoice === 'custom',
            default: config.cloudUrl
        },
        {
            type: 'input',
            name: 'defaultProjectId',
            message: 'Default Project ID:',
            default: config.defaultProjectId
        },
        {
            type: 'input',
            name: 'defaultProjectDir',
            message: 'Default Project Directory:',
            default: config.defaultProjectDir || process.cwd()
        },
        {
            type: 'confirm',
            name: 'autoSetProjectId',
            message: 'Enable autoSetProjectId?',
            default: config.autoSetProjectId !== false
        }
    ]);

    const finalCloudUrl = answers.cloudUrlChoice === 'custom' ? answers.customCloudUrl : answers.cloudUrlChoice;

    config.cloudUrl = finalCloudUrl;
    config.defaultProjectId = answers.defaultProjectId || undefined;
    config.defaultProjectDir = answers.defaultProjectDir || undefined;
    config.autoSetProjectId = answers.autoSetProjectId;

    saveConfigsFile(configsFile);

    // Attempt registration
    await ensureRegistered(config);

    console.log(`Configuration "${name}" updated.`);
}

function deleteConfig(name: string) {
    const configsFile = loadConfigsFile();
    const idx = configsFile.configs.findIndex(c => c.name === name);
    if (idx === -1) {
        console.error(`Configuration "${name}" not found.`);
        process.exit(1);
    }
    configsFile.configs.splice(idx, 1);

    // If this was the active config, try to pick another one
    if (configsFile.activeConfigName === name) {
        if (configsFile.configs.length > 0) {
            configsFile.activeConfigName = configsFile.configs[0].name;
        } else {
            delete configsFile.activeConfigName;
        }
    }

    saveConfigsFile(configsFile);
    console.log(`Configuration "${name}" deleted.`);
}

function listConfigs() {
    const configsFile = loadConfigsFile();
    if (configsFile.configs.length === 0) {
        console.log('No configurations found.');
        return;
    }

    const activeName = configsFile.activeConfigName;
    console.log('Configurations:');
    configsFile.configs.forEach(c => {
        const prefix = c.name === activeName ? '*' : ' ';
        console.log(`${prefix} ${c.name} (cloudUrl: ${c.cloudUrl}, defaultProjectId: ${c.defaultProjectId || 'none'}, defaultProjectDir: ${c.defaultProjectDir || 'none'})`);
    });
}

function generateUniqueConfigName(configsFile: CarsConfigsFile): string {
    let base = 'cars-config';
    let i = 1;
    let name = base;
    while (configsFile.configs.find(c => c.name === name)) {
        name = base + '-' + i++;
    }
    return name;
}

//
// Setting and getting config values
//

function getConfigValue(key: string) {
    const config = getActiveConfig();
    if (!config) {
        console.error('No active configuration.');
        process.exit(1);
    }
    if (!(key in config)) {
        console.error(`Key "${key}" not found in active configuration.`);
        process.exit(1);
    }
    // @ts-ignore
    console.log(config[key]);
}

async function setConfigValue(key: string, value: string) {
    const config = getActiveConfig();
    if (!config) {
        console.error('No active configuration.');
        process.exit(1);
    }
    if (!['cloudUrl', 'defaultProjectId', 'defaultProjectDir', 'autoSetProjectId'].includes(key)) {
        console.error(`Invalid key "${key}". Valid keys: cloudUrl, defaultProjectId, defaultProjectDir, autoSetProjectId`);
        process.exit(1);
    }

    if (key === 'autoSetProjectId') {
        // value should be boolean
        const boolVal = value.toLowerCase() === 'true';
        config.autoSetProjectId = boolVal;
    } else {
        // @ts-ignore
        config[key] = value;
    }

    updateActiveConfig(config);

    if (key === 'cloudUrl') {
        await ensureRegistered(config);
    }

    console.log(`Set "${key}" to "${value}" in the active configuration.`);
}

//
// Project logic
//

async function buildArtifact() {
    if (!fs.existsSync('deployment-info.json')) {
        console.error('No deployment-info.json found in current directory.');
        process.exit(1);
    }
    const deploymentInfo: DeploymentInfo = JSON.parse(fs.readFileSync('deployment-info.json', 'utf-8'));
    if (deploymentInfo.schema !== 'bsv-app') {
        console.error('Invalid schema in deployment-info.json');
        process.exit(1);
    }

    console.log('Building local project artifact...');
    const artifactName = `cars_artifact_${Date.now()}.tgz`;
    spawnSync('npm', ['i'], { stdio: 'inherit' });
    // Attempt to compile backend if npm run compile is available
    if (fs.existsSync('backend/package.json')) {
        spawnSync('npm', ['i'], { cwd: 'backend', stdio: 'inherit' });
        spawnSync('npm', ['run', 'compile'], { cwd: 'backend', stdio: 'inherit' });
        spawnSync('npm', ['run', 'build'], { cwd: 'backend', stdio: 'inherit' });
    }
    if (fs.existsSync('frontend/package.json')) {
        spawnSync('npm', ['i'], { cwd: 'frontend', stdio: 'inherit' });
        spawnSync('npm', ['run', 'build'], { cwd: 'frontend', stdio: 'inherit' });
    }
    await tar.create(
        { gzip: true, file: artifactName },
        ['backend', 'frontend', 'deployment-info.json', 'package.json', 'package-lock.json'].filter(fs.existsSync)
    );
    console.log(chalk.green(`Artifact created: ${artifactName}`));
    return artifactName;
}

/**
 * Find the latest built artifact
 */
function findLatestArtifact(): string {
    const artifacts = fs.readdirSync(process.cwd()).filter(f => f.startsWith('cars_artifact_') && f.endsWith('.tgz'));
    const found = artifacts.sort().pop();
    if (!found) {
        console.error('No artifact, run `cars build` first.')
        process.exit(1);
    }
    return found;
}

/**
 * Helper to pretty-print JSON
 */
function printJSON(obj: any) {
    console.log(JSON.stringify(obj, null, 2));
}

//
// Handling projectId inference
//

function maybeUpdateProjectIdInConfig(config: CarsConfigProfile, projectId: string) {
    // If autoSetProjectId is true and we have a defaultProjectDir equal to current directory,
    // update the defaultProjectId to the given projectId if it's different.
    if (config.autoSetProjectId !== false) {
        if (!config.defaultProjectDir) {
            config.defaultProjectDir = process.cwd();
            updateActiveConfig(config);
        }

        if (config.defaultProjectDir === process.cwd() && config.defaultProjectId !== projectId) {
            config.defaultProjectId = projectId;
            updateActiveConfig(config);
        }
    }
}

//
// Commands
//

// Config commands

program
    .command('config create [name]')
    .description('Create a new configuration profile')
    .action(async (name) => {
        await createConfigInteractive(name);
    });

program
    .command('config list')
    .description('List all configuration profiles')
    .action(() => {
        listConfigs();
    });

program
    .command('config activate <name>')
    .description('Activate a configuration profile')
    .action(async (name) => {
        setActiveConfig(name);
        const config = getActiveConfig();
        if (!config) {
            console.error('Failed to activate configuration.');
            process.exit(1);
        }
        await ensureRegistered(config);
        console.log(`Configuration "${name}" is now active.`);
    });

program
    .command('config edit <name>')
    .description('Edit a configuration profile')
    .action(async (name) => {
        await editConfigInteractive(name);
    });

program
    .command('config delete <name>')
    .description('Delete a configuration profile')
    .action((name) => {
        deleteConfig(name);
    });

program
    .command('config get <key>')
    .description('Get a value from the currently-active config')
    .action((key) => {
        getConfigValue(key);
    });

program
    .command('config set <key> <value>')
    .description('Set a value in the currently-active config')
    .action(async (key, value) => {
        await setConfigValue(key, value);
    });

program
    .command('config reset')
    .description('Reset your CARS configurations (delete all).')
    .action(() => {
        deleteConfigFile();
        console.log('CARS configs deleted.');
    });

// Build command

program
    .command('build')
    .description('Build local artifact for deployment')
    .action(async () => {
        await requireActiveConfig(true);
        await buildArtifact();
    });

//
// Project Commands
//

program
    .command('project create')
    .description('Create a new project')
    .action(async () => {
        const config = await requireActiveConfig(true);
        const client = new AuthriteClient(config.cloudUrl);
        const result = await client.createSignedRequest('/api/v1/project/create', {});
        printJSON(result);
    });

program
    .command('project ls')
    .description('List all projects for which the user is an admin')
    .action(async () => {
        const config = await requireActiveConfig(true);
        const client = new AuthriteClient(config.cloudUrl);
        const result = await client.createSignedRequest('/api/v1/projects/list', {});
        printJSON(result);
    });

program
    .command('project add-admin <projectId> <identityKey>')
    .description('Add an admin to a project')
    .action(async (projectId, identityKey) => {
        const config = await requireActiveConfig(true);
        const client = new AuthriteClient(config.cloudUrl);
        const result = await client.createSignedRequest(`/api/v1/project/${projectId}/addAdmin`, { identityKey });
        printJSON(result);
    });

program
    .command('project remove-admin <projectId> <identityKey>')
    .description('Remove an admin from a project')
    .action(async (projectId, identityKey) => {
        const config = await requireActiveConfig(true);
        const client = new AuthriteClient(config.cloudUrl);
        const result = await client.createSignedRequest(`/api/v1/project/${projectId}/removeAdmin`, { identityKey });
        printJSON(result);
    });

program
    .command('project logs <projectId>')
    .description('View logs of a project')
    .action(async (projectId) => {
        const config = await requireActiveConfig(true);
        const client = new AuthriteClient(config.cloudUrl);
        const result = await client.createSignedRequest(`/api/v1/project/${projectId}/logs/show`, {});
        printJSON(result);
    });

program
    .command('project deploys <projectId>')
    .description('List all deployments for a project')
    .action(async (projectId) => {
        const config = await requireActiveConfig(true);
        const client = new AuthriteClient(config.cloudUrl);
        const result = await client.createSignedRequest(`/api/v1/project/${projectId}/deploys/list`, {});
        printJSON(result);
    });

//
// Deployment Commands
//

program
    .command('deploy <projectId>')
    .description('Deploy a project')
    .action(async (projectId) => {
        const config = await requireActiveConfig(true);
        const artifactPath = findLatestArtifact();

        // Possibly update config if needed
        maybeUpdateProjectIdInConfig(config, projectId);

        const client = new AuthriteClient(config.cloudUrl);
        const result = await client.createSignedRequest(`/api/v1/project/${projectId}/deploy`, {});
        // result should include { url, deploymentId }
        const spinner = ora('Uploading artifact...').start();
        const artifactData = fs.readFileSync(artifactPath);
        try {
            // The upload endpoint expects a POST request with octet-stream body
            await axios.post(result.url, artifactData, {
                headers: {
                    'Content-Type': 'application/octet-stream'
                }
            });
            spinner.succeed('Artifact uploaded successfully.');
        } catch (error: any) {
            spinner.fail('Artifact upload failed.');
            console.error(error.response?.data || error.message);
        }
    });

program
    .command('deploy get-upload-url <projectId>')
    .description('Create a new deployment for a project and get the upload URL')
    .action(async (projectId) => {
        const config = await requireActiveConfig(true);

        maybeUpdateProjectIdInConfig(config, projectId);

        const client = new AuthriteClient(config.cloudUrl);
        const result = await client.createSignedRequest(`/api/v1/project/${projectId}/deploy`, {});
        // result should include { url, deploymentId }
        console.log(`Deployment created. Deployment ID: ${result.deploymentId}`);
        console.log(`Upload URL: ${result.url}`);
    });

program
    .command('deploy upload-files <uploadURL> <artifactPath>')
    .description('Upload a built artifact to the given URL')
    .action(async (uploadURL, artifactPath) => {
        await requireActiveConfig(true);

        if (!fs.existsSync(artifactPath)) {
            console.error(`Artifact not found: ${artifactPath}`);
            process.exit(1);
        }
        const spinner = ora('Uploading artifact...').start();
        const artifactData = fs.readFileSync(artifactPath);
        try {
            // The upload endpoint expects a POST request with octet-stream body
            await axios.post(uploadURL, artifactData, {
                headers: {
                    'Content-Type': 'application/octet-stream'
                }
            });
            spinner.succeed('Artifact uploaded successfully.');
        } catch (error: any) {
            spinner.fail('Artifact upload failed.');
            console.error(error.response?.data || error.message);
        }
    });

program
    .command('deploy logs <deploymentId>')
    .description('View logs of a deployment')
    .action(async (deploymentId) => {
        const config = await requireActiveConfig(true);
        const client = new AuthriteClient(config.cloudUrl);
        const result = await client.createSignedRequest(`/api/v1/deploy/${deploymentId}/logs/show`, {});
        printJSON(result);
    });

program.parse(process.argv);
