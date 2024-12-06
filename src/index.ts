#!/usr/bin/env node
import { program } from 'commander';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import ora from 'ora';
import * as tar from 'tar';
import os from 'os';
import { spawnSync } from 'child_process';
import { AuthriteClient } from 'authrite-js';
import chalk from 'chalk';

const client = new AuthriteClient()

interface DeploymentInfo {
    schema: string;
    schemaVersion: string;
    topicManagers?: Record<string, string>;
    lookupServices?: Record<string, { serviceFactory: string; hydrateWith?: string }>;
    frontend?: { language: string; sourceDirectory: string };
    contracts?: { language: string; baseDirectory: string };
}

const CARS_CONFIG_PATH = path.resolve(os.homedir(), '.cars-config.json');

async function loadConfig(interfactive = true) {
    if (fs.existsSync(CARS_CONFIG_PATH)) {
        return JSON.parse(fs.readFileSync(CARS_CONFIG_PATH, 'utf-8'));
    }
    // TODO: Interactive = true as parameter.
    // If interactive, show a list of providers.
    // Optionally, they can enter a custom CARS cloud URL of their choosing.
    // User selects a provider, calls register, and gets set up.
    // Then, we return.
    await registerForCars('https://cars.babbage.systems');
    return { cloudUrl: 'https://cars.babbage.systems' };
}

function saveConfig(config: any) {
    fs.writeFileSync(CARS_CONFIG_PATH, JSON.stringify(config, null, 2));
}

function deleteConfig() {
    fs.rmSync(CARS_CONFIG_PATH);
}

async function registerForCars(url: string) {
    const result = await client.request(`${url}/api/v1/register`);
    console.log(result)
    console.log(`Registered for CARS Cloud at ${url}`);
}

program
    .command('register')
    .description('Register for CARS cloud')
    .action(async () => {
        const config = await loadConfig()
        saveConfig(config)
        console.log(`Logged in to CARS Cloud at ${cloudUrl}`);
    });

program
    .command('reset')
    .description('Reset your CARS configuration.')
    .action(async () => {
        deleteConfig()
        console.log('CARS conig deleted.')
    });

program
    .command('build')
    .description('Build local artifact for deployment')
    .action(async () => {
        // Validate deployment-info.json
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
            // TODO: Allow a new deployment-info.json field "deploy" to specify whether backend, frontend, or both are deployed.
            // For each, allow a set of providers to be providd within each context, and only deploy when we are one of the speciied deployment providers.
            ['backend', 'frontend', 'deployment-info.json', 'package.json', 'package-lock.json'].filter(fs.existsSync)
        );
        console.log(chalk.green(`Artifact created: ${artifactName}`));
    });

program
    .command('deploy')
    .description('Deploy artifact to CARS cloud')
    .action(async () => {
        // Find the latest artifact
        const artifacts = fs.readdirSync(process.cwd()).filter(f => f.startsWith('cars_artifact_') && f.endsWith('.tgz'));
        if (artifacts.length === 0) {
            console.error('No artifact found. Run `cars build` first.');
            process.exit(1);
        }
        const artifact = artifacts.sort().pop();

        const config = await loadConfig();
        const spinner = ora('Uploading artifact...').start();
        const artifactData = fs.readFileSync(artifact!);
        // Request signed URL for new deployment from CARS cloud
        // Upload with Axios
        try {
            await axios.post(`${config.cloudUrl}/api/deploy`, artifactData, {
                headers: {
                    Authorization: `Bearer ${config.token}`,
                    'Content-Type': 'application/octet-stream'
                }
            });
            spinner.succeed('Artifact uploaded successfully.');
            console.log('Deployment initiated. Check the CARS dashboard for status.');
        } catch (error: any) {
            spinner.fail('Artifact upload failed.');
            console.error(error.response?.data || error.message);
        }
    });

program.parse(process.argv);
