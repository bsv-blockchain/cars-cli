#!/usr/bin/env node
import { program } from 'commander';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import * as tar from 'tar';
import { spawnSync } from 'child_process';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { AuthriteClient } from 'authrite-js';

/**
 * Types
 */

interface DeploymentInfo {
    schema: string;
    schemaVersion: string;
    topicManagers?: Record<string, string>;
    lookupServices?: Record<string, { serviceFactory: string; hydrateWith?: string }>;
    frontend?: { language: string; sourceDirectory: string };
    contracts?: { language: string; baseDirectory: string };
    deployments?: Deployment[];
}

interface Deployment {
    name: string;
    network?: string;
    provider: string; // "CARS" or "LARS" or others
    projectID?: string;
    CARSCloudURL?: string;
    deploy?: string[]; // "frontend", "backend"
    frontendHostingMethod?: string;
    authentication?: any;
    payments?: any;
}

/**
 * Constants
 */

const DEPLOYMENT_INFO_PATH = path.resolve(process.cwd(), 'deployment-info.json');

/**
 * Utility functions
 */

function loadDeploymentInfo(): DeploymentInfo {
    if (!fs.existsSync(DEPLOYMENT_INFO_PATH)) {
        console.error(chalk.red('❌ deployment-info.json not found in the current directory.'));
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(DEPLOYMENT_INFO_PATH, 'utf-8'));
}

function saveDeploymentInfo(info: DeploymentInfo) {
    fs.writeFileSync(DEPLOYMENT_INFO_PATH, JSON.stringify(info, null, 2));
}

function getCARSDeployments(info: DeploymentInfo): Deployment[] {
    return (info.deployments || []).filter(d => d.provider === 'CARS');
}

function findCARSDeploymentByNameOrIndex(info: DeploymentInfo, nameOrIndex?: string): Deployment | undefined {
    const carsDeployments = getCARSDeployments(info);
    if (carsDeployments.length === 0) return undefined;

    if (!nameOrIndex) {
        // No argument, prompt user
        return undefined;
    }

    const index = parseInt(nameOrIndex, 10);
    if (!isNaN(index)) {
        return carsDeployments[index];
    }

    return carsDeployments.find(d => d.name === nameOrIndex);
}

async function pickCARSDeployment(info: DeploymentInfo): Promise<Deployment> {
    const carsDeployments = getCARSDeployments(info);
    if (carsDeployments.length === 0) {
        console.log(chalk.yellow('No CARS deployments found. Let’s create one.'));
        const newDep = await addCARSDeploymentInteractive(info);
        return newDep;
    }

    const choices = carsDeployments.map((d, i) => ({
        name: `${i}: ${d.name} (CARSCloudURL: ${d.CARSCloudURL}, projectID: ${d.projectID || 'none'})`,
        value: i
    }));

    const { chosenIndex } = await inquirer.prompt([
        {
            type: 'list',
            name: 'chosenIndex',
            message: 'Select a CARS deployment:',
            choices
        }
    ]);

    return carsDeployments[chosenIndex];
}

async function ensureRegistered(carsDeployment: Deployment) {
    if (!carsDeployment.CARSCloudURL) {
        console.error(chalk.red('❌ No CARS Cloud URL set in the chosen deployment.'));
        process.exit(1);
    }
    const client = new AuthriteClient(carsDeployment.CARSCloudURL);
    try {
        await client.createSignedRequest('/api/v1/register', {});
    } catch (error: any) {
        console.error(chalk.red(`❌ Failed to register with CARS Cloud at ${carsDeployment.CARSCloudURL}.`));
        console.error(error.response?.data || error.message);
        process.exit(1);
    }
}

/**
 * Interactive editing of deployments
 */

async function addCARSDeploymentInteractive(info: DeploymentInfo): Promise<Deployment> {
    const cloudChoices = [
        { name: 'localhost:7777', value: 'http://localhost:7777' },
        { name: 'cars-cloud1.com', value: 'https://cars-cloud1.com' },
        { name: 'cars-cloud2.com', value: 'https://cars-cloud2.com' },
        { name: 'cars-cloud3.com', value: 'https://cars-cloud3.com' },
        { name: 'Custom', value: 'custom' }
    ];

    const { name, cloudUrlChoice, customCloudUrl, projectID, network, deployTargets, frontendHosting } = await inquirer.prompt([
        {
            type: 'input',
            name: 'name',
            message: 'Name of this CARS deployment:',
            validate: (val: string) => val.trim() ? true : 'Name is required.'
        },
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
            type: 'input',
            name: 'projectID',
            message: 'Project ID for this deployment:',
            validate: (val: string) => val.trim() ? true : 'Project ID is required.'
        },
        {
            type: 'input',
            name: 'network',
            message: 'Network (e.g. testnet/mainnet):',
            default: 'mainnet'
        },
        {
            type: 'checkbox',
            name: 'deployTargets',
            message: 'Select what to deploy:',
            choices: [
                { name: 'frontend', value: 'frontend', checked: true },
                { name: 'backend', value: 'backend', checked: true },
            ]
        },
        {
            type: 'list',
            name: 'frontendHosting',
            message: 'Frontend hosting method (HTTPS/UHRP/none):',
            choices: ['HTTPS', 'UHRP', 'none'],
            default: 'HTTPS'
        }
    ]);

    const finalCloudUrl = cloudUrlChoice === 'custom' ? customCloudUrl : cloudUrlChoice;

    const newDep: Deployment = {
        name,
        provider: 'CARS',
        CARSCloudURL: finalCloudUrl,
        projectID: projectID.trim(),
        network: network.trim(),
        deploy: deployTargets,
        frontendHostingMethod: frontendHosting === 'none' ? undefined : frontendHosting
    };

    info.deployments = info.deployments || [];
    info.deployments.push(newDep);
    saveDeploymentInfo(info);

    // Attempt registration
    await ensureRegistered(newDep);

    console.log(chalk.green(`✅ CARS deployment "${name}" created.`));
    return newDep;
}

async function editCARSDeploymentInteractive(info: DeploymentInfo, deployment: Deployment) {
    const cloudChoices = [
        { name: 'localhost:7777', value: 'http://localhost:7777' },
        { name: 'cars-cloud1.com', value: 'https://cars-cloud1.com' },
        { name: 'cars-cloud2.com', value: 'https://cars-cloud2.com' },
        { name: 'cars-cloud3.com', value: 'https://cars-cloud3.com' },
        { name: 'Custom', value: 'custom' }
    ];

    const currentCloudChoice = cloudChoices.find(ch => ch.value === deployment.CARSCloudURL) ? deployment.CARSCloudURL : 'custom';

    const { name, cloudUrlChoice, customCloudUrl, projectID, network, deployTargets, frontendHosting } = await inquirer.prompt([
        {
            type: 'input',
            name: 'name',
            message: 'Deployment name:',
            default: deployment.name,
            validate: (val: string) => val.trim() ? true : 'Name is required.'
        },
        {
            type: 'list',
            name: 'cloudUrlChoice',
            message: 'CARS Cloud URL:',
            choices: cloudChoices,
            default: currentCloudChoice
        },
        {
            type: 'input',
            name: 'customCloudUrl',
            message: 'Enter custom CARS Cloud URL:',
            when: (ans) => ans.cloudUrlChoice === 'custom',
            default: deployment.CARSCloudURL || 'http://localhost:7777'
        },
        {
            type: 'input',
            name: 'projectID',
            message: 'Project ID:',
            default: deployment.projectID,
            validate: (val: string) => val.trim() ? true : 'Project ID is required.'
        },
        {
            type: 'input',
            name: 'network',
            message: 'Network:',
            default: deployment.network || 'testnet'
        },
        {
            type: 'checkbox',
            name: 'deployTargets',
            message: 'What to deploy?',
            choices: [
                { name: 'frontend', value: 'frontend', checked: deployment.deploy?.includes('frontend') },
                { name: 'backend', value: 'backend', checked: deployment.deploy?.includes('backend') },
            ]
        },
        {
            type: 'list',
            name: 'frontendHosting',
            message: 'Frontend hosting method:',
            choices: ['HTTPS', 'UHRP', 'none'],
            default: deployment.frontendHostingMethod || 'none'
        }
    ]);

    const finalCloudUrl = cloudUrlChoice === 'custom' ? customCloudUrl : cloudUrlChoice;

    deployment.name = name.trim();
    deployment.CARSCloudURL = finalCloudUrl;
    deployment.projectID = projectID.trim();
    deployment.network = network.trim();
    deployment.deploy = deployTargets;
    deployment.frontendHostingMethod = frontendHosting === 'none' ? undefined : frontendHosting;

    saveDeploymentInfo(info);

    await ensureRegistered(deployment);

    console.log(chalk.green(`✅ CARS deployment "${name}" updated.`));
}

function deleteCARSDeployment(info: DeploymentInfo, deployment: Deployment) {
    info.deployments = (info.deployments || []).filter(d => d !== deployment);
    saveDeploymentInfo(info);
    console.log(chalk.green(`✅ CARS deployment "${deployment.name}" deleted.`));
}

/**
 * Build logic
 */

async function buildArtifact() {
    if (!fs.existsSync('deployment-info.json')) {
        console.error(chalk.red('❌ No deployment-info.json found in current directory.'));
        process.exit(1);
    }
    const deploymentInfo: DeploymentInfo = JSON.parse(fs.readFileSync('deployment-info.json', 'utf-8'));
    if (deploymentInfo.schema !== 'bsv-app') {
        console.error(chalk.red('❌ Invalid schema in deployment-info.json'));
        process.exit(1);
    }

    console.log(chalk.blue('🛠  Building local project artifact...'));
    const artifactName = `cars_artifact_${Date.now()}.tgz`;
    spawnSync('npm', ['i'], { stdio: 'inherit' });
    if (fs.existsSync('backend/package.json')) {
        spawnSync('npm', ['i'], { cwd: 'backend', stdio: 'inherit' });
        spawnSync('npm', ['run', 'compile'], { cwd: 'backend', stdio: 'inherit' });
        spawnSync('npm', ['run', 'build'], { cwd: 'backend', stdio: 'inherit' });
    }
    if (fs.existsSync('frontend/package.json')) {
        spawnSync('npm', ['i'], { cwd: 'frontend', stdio: 'inherit' });
        spawnSync('npm', ['run', 'build'], { cwd: 'frontend', stdio: 'inherit' });
    }

    const filesToInclude = ['backend', 'frontend', 'deployment-info.json', 'package.json', 'package-lock.json'].filter(fs.existsSync);
    await tar.create({ gzip: true, file: artifactName }, filesToInclude);
    console.log(chalk.green(`✅ Artifact created: ${artifactName}`));
    return artifactName;
}

/**
 * Find the latest built artifact
 */
function findLatestArtifact(): string {
    const artifacts = fs.readdirSync(process.cwd()).filter(f => f.startsWith('cars_artifact_') && f.endsWith('.tgz'));
    const found = artifacts.sort().pop();
    if (!found) {
        console.error(chalk.red('❌ No artifact found. Run `cars build` first.'));
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

/**
 * Project commands
 */

async function getAuthriteClientForDeployment(deployment: Deployment) {
    if (!deployment.CARSCloudURL) {
        console.error(chalk.red('❌ CARSCloudURL not set on this deployment.'));
        process.exit(1);
    }
    await ensureRegistered(deployment);
    return new AuthriteClient(deployment.CARSCloudURL);
}

/**
 * CLI Definition
 */

// cars config
const configCommand = program
    .command('config')
    .description('Manage CARS deployments in deployment-info.json');

configCommand
    .command('ls')
    .description('List all CARS deployments')
    .action(() => {
        const info = loadDeploymentInfo();
        const cars = getCARSDeployments(info);
        if (cars.length === 0) {
            console.log(chalk.yellow('No CARS deployments found.'));
            return;
        }
        console.log(chalk.blue('CARS deployments:'));
        cars.forEach((c, i) => {
            console.log(`${i}: ${c.name} (CARSCloudURL: ${c.CARSCloudURL}, projectID: ${c.projectID || 'none'})`);
        });
    });

configCommand
    .command('add')
    .description('Add a new CARS deployment')
    .action(async () => {
        const info = loadDeploymentInfo();
        await addCARSDeploymentInteractive(info);
    });

configCommand
    .command('edit <nameOrIndex>')
    .description('Edit a CARS deployment')
    .action(async (nameOrIndex) => {
        const info = loadDeploymentInfo();
        const dep = findCARSDeploymentByNameOrIndex(info, nameOrIndex);
        if (!dep) {
            console.error(chalk.red(`❌ CARS deployment "${nameOrIndex}" not found.`));
            process.exit(1);
        }
        await editCARSDeploymentInteractive(info, dep);
    });

configCommand
    .command('delete <nameOrIndex>')
    .description('Delete a CARS deployment')
    .action((nameOrIndex) => {
        const info = loadDeploymentInfo();
        const dep = findCARSDeploymentByNameOrIndex(info, nameOrIndex);
        if (!dep) {
            console.error(chalk.red(`❌ CARS deployment "${nameOrIndex}" not found.`));
            process.exit(1);
        }
        deleteCARSDeployment(info, dep);
    });

configCommand
    .action(async () => {
        // Interactive menu to manage deployments
        const info = loadDeploymentInfo();
        const carsDeployments = getCARSDeployments(info);

        const mainChoices = [
            { name: 'List CARS deployments', value: 'ls' },
            { name: 'Add a new CARS deployment', value: 'add' }
        ];

        if (carsDeployments.length > 0) {
            mainChoices.push({ name: 'Edit an existing CARS deployment', value: 'edit' });
            mainChoices.push({ name: 'Delete a CARS deployment', value: 'delete' });
        }

        mainChoices.push({ name: 'Exit', value: 'exit' });

        let done = false;
        while (!done) {
            const { action } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'action',
                    message: 'CARS Configuration Menu',
                    choices: mainChoices
                }
            ]);

            if (action === 'ls') {
                console.log(chalk.blue('CARS deployments:'));
                const cars = getCARSDeployments(info);
                if (cars.length === 0) {
                    console.log(chalk.yellow('No CARS deployments found.'));
                } else {
                    cars.forEach((c, i) => {
                        console.log(`${i}: ${c.name} (CARSCloudURL: ${c.CARSCloudURL}, projectID: ${c.projectID})`);
                    });
                }
            } else if (action === 'add') {
                await addCARSDeploymentInteractive(info);
            } else if (action === 'edit') {
                const cars = getCARSDeployments(info);
                if (cars.length === 0) {
                    console.log(chalk.yellow('No CARS deployments to edit.'));
                } else {
                    const { chosenIndex } = await inquirer.prompt([
                        {
                            type: 'list',
                            name: 'chosenIndex',
                            message: 'Select a CARS deployment to edit:',
                            choices: cars.map((d, i) => ({
                                name: `${i}: ${d.name} (CARSCloudURL: ${d.CARSCloudURL})`,
                                value: i
                            }))
                        }
                    ]);
                    await editCARSDeploymentInteractive(info, cars[chosenIndex]);
                }
            } else if (action === 'delete') {
                const cars = getCARSDeployments(info);
                if (cars.length === 0) {
                    console.log(chalk.yellow('No CARS deployments to delete.'));
                } else {
                    const { chosenIndex } = await inquirer.prompt([
                        {
                            type: 'list',
                            name: 'chosenIndex',
                            message: 'Select a CARS deployment to delete:',
                            choices: cars.map((d, i) => ({
                                name: `${i}: ${d.name} (CARSCloudURL: ${d.CARSCloudURL})`,
                                value: i
                            }))
                        }
                    ]);
                    deleteCARSDeployment(info, cars[chosenIndex]);
                }
            } else {
                done = true;
            }
        }
    });

// build
program
    .command('build')
    .description('Build local artifact for deployment')
    .action(async () => {
        await buildArtifact();
    });

// project
const projectCommand = program
    .command('project')
    .description('Manage projects via CARS');

projectCommand
    .command('create')
    .description('Create a new project on a chosen CARS deployment')
    .action(async () => {
        const info = loadDeploymentInfo();
        const deployment = await pickCARSDeployment(info);
        const client = await getAuthriteClientForDeployment(deployment);
        const result = await client.createSignedRequest('/api/v1/project/create', {});
        printJSON(result);
    });

projectCommand
    .command('ls')
    .description('List all projects (for the chosen CARS deployment)')
    .action(async () => {
        const info = loadDeploymentInfo();
        const deployment = await pickCARSDeployment(info);
        const client = await getAuthriteClientForDeployment(deployment);
        const result = await client.createSignedRequest('/api/v1/projects/list', {});
        printJSON(result);
    });

projectCommand
    .command('add-admin <identityKey>')
    .description('Add an admin to the project')
    .action(async (identityKey) => {
        const info = loadDeploymentInfo();
        const deployment = await pickCARSDeployment(info);
        if (!deployment.projectID) {
            console.error(chalk.red('❌ No project ID set in this deployment.'));
            process.exit(1);
        }
        const client = await getAuthriteClientForDeployment(deployment);
        const result = await client.createSignedRequest(`/api/v1/project/${deployment.projectID}/addAdmin`, { identityKey });
        printJSON(result);
    });

projectCommand
    .command('remove-admin <identityKey>')
    .description('Remove an admin from the project')
    .action(async (identityKey) => {
        const info = loadDeploymentInfo();
        const deployment = await pickCARSDeployment(info);
        if (!deployment.projectID) {
            console.error(chalk.red('❌ No project ID set in this deployment.'));
            process.exit(1);
        }
        const client = await getAuthriteClientForDeployment(deployment);
        const result = await client.createSignedRequest(`/api/v1/project/${deployment.projectID}/removeAdmin`, { identityKey });
        printJSON(result);
    });

projectCommand
    .command('logs')
    .description('View logs of the project')
    .action(async () => {
        const info = loadDeploymentInfo();
        const deployment = await pickCARSDeployment(info);
        if (!deployment.projectID) {
            console.error(chalk.red('❌ No project ID set in this deployment.'));
            process.exit(1);
        }
        const client = await getAuthriteClientForDeployment(deployment);
        const result = await client.createSignedRequest(`/api/v1/project/${deployment.projectID}/logs/show`, {});
        printJSON(result);
    });

projectCommand
    .command('deploys')
    .description('List all deployments for the project')
    .action(async () => {
        const info = loadDeploymentInfo();
        const deployment = await pickCARSDeployment(info);
        if (!deployment.projectID) {
            console.error(chalk.red('❌ No project ID set in this deployment.'));
            process.exit(1);
        }
        const client = await getAuthriteClientForDeployment(deployment);
        const result = await client.createSignedRequest(`/api/v1/project/${deployment.projectID}/deploys/list`, {});
        printJSON(result);
    });

// deploy
const deployCommand = program
    .command('deploy')
    .description('Manage deployments via CARS');

deployCommand
    .command('get-upload-url [nameOrIndex]')
    .description('Create a new deployment for a chosen CARS deployment and get the upload URL')
    .action(async (nameOrIndex) => {
        const info = loadDeploymentInfo();
        const deployment = nameOrIndex
            ? findCARSDeploymentByNameOrIndex(info, nameOrIndex) || (await pickCARSDeployment(info))
            : await pickCARSDeployment(info);

        if (!deployment.projectID) {
            console.error(chalk.red('❌ No project ID set in this deployment.'));
            process.exit(1);
        }
        const client = await getAuthriteClientForDeployment(deployment);
        const result = await client.createSignedRequest(`/api/v1/project/${deployment.projectID}/deploy`, {});
        console.log(chalk.green(`✅ Deployment created. Deployment ID: ${result.deploymentId}`));
        console.log(`Upload URL: ${result.url}`);
    });

deployCommand
    .command('upload-files <uploadURL> <artifactPath>')
    .description('Upload a built artifact to the given URL')
    .action(async (uploadURL, artifactPath) => {
        const { default: ora } = await import('ora');
        if (!fs.existsSync(artifactPath)) {
            console.error(chalk.red(`❌ Artifact not found: ${artifactPath}`));
            process.exit(1);
        }
        const spinner = ora('Uploading artifact...').start();
        const artifactData = fs.readFileSync(artifactPath);
        try {
            await axios.post(uploadURL, artifactData, {
                headers: {
                    'Content-Type': 'application/octet-stream'
                }
            });
            spinner.succeed('✅ Artifact uploaded successfully.');
        } catch (error: any) {
            spinner.fail('❌ Artifact upload failed.');
            console.error(error.response?.data || error.message);
            process.exit(1);
        }
    });

deployCommand
    .command('logs <deploymentId> [nameOrIndex]')
    .description('View logs of a deployment by its ID')
    .action(async (deploymentId, nameOrIndex) => {
        const info = loadDeploymentInfo();
        const deployment = nameOrIndex
            ? findCARSDeploymentByNameOrIndex(info, nameOrIndex) || (await pickCARSDeployment(info))
            : await pickCARSDeployment(info);
        const client = await getAuthriteClientForDeployment(deployment);
        const result = await client.createSignedRequest(`/api/v1/deploy/${deploymentId}/logs/show`, {});
        printJSON(result);
    });

deployCommand
    .command('now [nameOrIndex]')
    .description('Build and deploy the latest artifact directly to the chosen CARS deployment')
    .action(async (nameOrIndex) => {
        const { default: ora } = await import('ora');
        const info = loadDeploymentInfo();
        const deployment = nameOrIndex
            ? findCARSDeploymentByNameOrIndex(info, nameOrIndex) || (await pickCARSDeployment(info))
            : await pickCARSDeployment(info);

        if (!deployment.projectID) {
            console.error(chalk.red('❌ No project ID set in this deployment.'));
            process.exit(1);
        }

        const artifactPath = findLatestArtifact();
        const client = await getAuthriteClientForDeployment(deployment);
        const result = await client.createSignedRequest(`/api/v1/project/${deployment.projectID}/deploy`, {});
        const spinner = ora('Uploading artifact...').start();
        const artifactData = fs.readFileSync(artifactPath);
        try {
            await axios.post(result.url, artifactData, {
                headers: {
                    'Content-Type': 'application/octet-stream'
                }
            });
            spinner.succeed('✅ Artifact uploaded successfully.');
        } catch (error: any) {
            spinner.fail('❌ Artifact upload failed.');
            console.error(error.response?.data || error.message);
            process.exit(1);
        }
    });

program.parse(process.argv);
