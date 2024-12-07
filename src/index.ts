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

// Make sure these imports match your environment
import { AuthriteClient } from 'authrite-js';

interface DeploymentInfo {
    schema: string;
    schemaVersion: string;
    topicManagers?: Record<string, string>;
    lookupServices?: Record<string, { serviceFactory: string; hydrateWith?: string }>;
    frontend?: { language: string; sourceDirectory: string };
    contracts?: { language: string; baseDirectory: string };
}

interface CARSConfig {
    cloudUrl?: string;
}

const CARS_CONFIG_PATH = path.resolve(os.homedir(), '.cars-config.json');

/**
 * Load config from ~/.cars-config.json if exists.
 * Otherwise, ask user to register.
 */
async function loadConfig(interactive = false): Promise<CARSConfig> {
    if (fs.existsSync(CARS_CONFIG_PATH)) {
        return JSON.parse(fs.readFileSync(CARS_CONFIG_PATH, 'utf-8'));
    }

    if (interactive) {
        const { cloudUrl } = await inquirer.prompt([
            {
                type: 'input',
                name: 'cloudUrl',
                message: 'CARS Cloud URL:',
                default: 'http://localhost:7777'
            }
        ]);
        await registerForCars(cloudUrl);
        return JSON.parse(fs.readFileSync(CARS_CONFIG_PATH, 'utf-8'));
    } else {
        console.error('Not registered. Run `cars register` first.');
        process.exit(1);
    }
}

/**
 * Save config to ~/.cars-config.json
 */
function saveConfig(config: CARSConfig) {
    fs.writeFileSync(CARS_CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * Delete config
 */
function deleteConfig() {
    if (fs.existsSync(CARS_CONFIG_PATH)) {
        fs.rmSync(CARS_CONFIG_PATH);
    }
}

/**
 * Initialize AuthriteClient from config.
 */
function getAuthriteClient(config: CARSConfig) {
    if (!config.cloudUrl) {
        console.error('Missing cloudUrl in config. Run `cars register` again.');
        process.exit(1);
    }

    return new AuthriteClient(config.cloudUrl)
}

/**
 * Register user on the CARS node
 */
async function registerForCars(url: string) {
    const client = new AuthriteClient(url);
    await client.createSignedRequest('/api/v1/register', {});
    console.log(`Registered with CARS Cloud at ${url}`);
    const config: CARSConfig = { cloudUrl: url };
    saveConfig(config);
}

/**
 * Ensure that the user is registered, or prompt them to register if not.
 */
async function requireRegistered(): Promise<CARSConfig> {
    const config = await loadConfig(true);
    if (!config.cloudUrl) {
        console.error('User not registered. Run `cars register`.');
        process.exit(1);
    }
    return config;
}

/**
 * Build local project artifact
 */
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
        process.exit(1)
    }
    return found
}

/**
 * Helper to pretty-print JSON
 */
function printJSON(obj: any) {
    console.log(JSON.stringify(obj, null, 2));
}

// CLI Commands

program
    .command('register [cloudUrl]')
    .description('Register for CARS cloud at the given URL (default: http://localhost:7777)')
    .action(async (cloudUrl: string) => {
        cloudUrl = cloudUrl || 'http://localhost:7777';
        await registerForCars(cloudUrl);
        console.log(`Logged in to CARS Cloud at ${cloudUrl}`);
    });

program
    .command('config reset')
    .description('Reset your CARS configuration.')
    .action(() => {
        deleteConfig();
        console.log('CARS config deleted.');
    });

program
    .command('build')
    .description('Build local artifact for deployment')
    .action(async () => {
        await buildArtifact();
    });

//
// Project Commands
//

program
    .command('project create')
    .description('Create a new project')
    .action(async () => {
        const config = await requireRegistered();
        const client = getAuthriteClient(config);
        const result = await client.createSignedRequest('/api/v1/project/create', {});
        printJSON(result);
    });

program
    .command('project ls')
    .description('List all projects for which the user is an admin')
    .action(async () => {
        const config = await requireRegistered();
        const client = getAuthriteClient(config);
        const result = await client.createSignedRequest('/api/v1/projects/list', {});
        printJSON(result);
    });

program
    .command('project add-admin <projectId> <identityKey>')
    .description('Add an admin to a project')
    .action(async (projectId, identityKey) => {
        const config = await requireRegistered();
        const client = getAuthriteClient(config);
        const result = await client.createSignedRequest(`/api/v1/project/${projectId}/addAdmin`, { identityKey });
        printJSON(result);
    });

program
    .command('project remove-admin <projectId> <identityKey>')
    .description('Remove an admin from a project')
    .action(async (projectId, identityKey) => {
        const config = await requireRegistered();
        const client = getAuthriteClient(config);
        const result = await client.createSignedRequest(`/api/v1/project/${projectId}/removeAdmin`, { identityKey });
        printJSON(result);
    });

program
    .command('project logs <projectId>')
    .description('View logs of a project')
    .action(async (projectId) => {
        const config = await requireRegistered();
        const client = getAuthriteClient(config);
        const result = await client.createSignedRequest(`/api/v1/project/${projectId}/logs/show`, {});
        printJSON(result);
    });

program
    .command('project deploys <projectId>')
    .description('List all deployments for a project')
    .action(async (projectId) => {
        const config = await requireRegistered();
        const client = getAuthriteClient(config);
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
        const artifactPath = findLatestArtifact();
        const config = await requireRegistered();
        const client = getAuthriteClient(config);
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
        const config = await requireRegistered();
        const client = getAuthriteClient(config);
        const result = await client.createSignedRequest(`/api/v1/project/${projectId}/deploy`, {});
        // result should include { url, deploymentId }
        console.log(`Deployment created. Deployment ID: ${result.deploymentId}`);
        console.log(`Upload URL: ${result.url}`);
    });

program
    .command('deploy upload-files <uploadURL> <artifactPath>')
    .description('Upload a built artifact to the given URL')
    .action(async (uploadURL, artifactPath) => {
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
        const config = await requireRegistered();
        const client = getAuthriteClient(config);
        const result = await client.createSignedRequest(`/api/v1/deploy/${deploymentId}/logs/show`, {});
        printJSON(result);
    });

program.parse(process.argv);
