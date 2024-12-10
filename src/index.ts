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
import ora from 'ora';
import Table from 'cli-table3';

/**
 * Types
 */

interface CARSConfigInfo {
    schema: string;
    schemaVersion: string;
    topicManagers?: Record<string, string>;
    lookupServices?: Record<string, { serviceFactory: string; hydrateWith?: string }>;
    frontend?: { language: string; sourceDirectory: string };
    contracts?: { language: string; baseDirectory: string };
    // Now called "configs" instead of "deployments"
    configs?: CARSConfig[];
}

interface CARSConfig {
    name: string;
    network?: string;
    provider: string; // "CARS" or "LARS" or others
    projectID?: string;
    CARSCloudURL?: string;
    deploy?: string[]; // which parts to release: "frontend", "backend"
    frontendHostingMethod?: string;
    authentication?: any;
    payments?: any;
}

/**
 * Constants
 */

const CONFIG_PATH = path.resolve(process.cwd(), 'deployment-info.json');
const ARTIFACT_PREFIX = 'cars_artifact_';
const ARTIFACT_EXTENSION = '.tgz';

/**
 * Utility functions
 */

function loadCARSConfigInfo(): CARSConfigInfo {
    if (!fs.existsSync(CONFIG_PATH)) {
        console.error(chalk.red('❌ deployment-info.json not found in the current directory.'));
        process.exit(1);
    }
    const info = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    // Migrate if using old "deployments" field
    if (info.deployments && !info.configs) {
        info.configs = info.deployments;
        delete info.deployments;
        saveCARSConfigInfo(info);
    }
    info.configs = info.configs || [];
    return info;
}

function saveCARSConfigInfo(info: CARSConfigInfo) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(info, null, 2));
}

function isCARSConfig(c: CARSConfig): boolean {
    return c.provider === 'CARS';
}

function listAllConfigs(info: CARSConfigInfo): CARSConfig[] {
    return info.configs || [];
}

function printAllConfigsWithIndex(info: CARSConfigInfo) {
    const all = listAllConfigs(info);
    if (all.length === 0) {
        console.log(chalk.yellow('No configurations found.'));
        return;
    }
    console.log(chalk.blue('All configurations:'));
    for (let i = 0; i < all.length; i++) {
        const c = all[i];
        if (isCARSConfig(c)) {
            console.log(`${i}: ${c.name} [CARS] (CloudURL: ${c.CARSCloudURL}, ProjectID: ${c.projectID || 'none'})`);
        } else {
            console.log(chalk.grey(`${i}: ${c.name} (Provider: ${c.provider}, Non-CARS)`));
        }
    }
}

function findConfigByNameOrIndex(info: CARSConfigInfo, nameOrIndex: string): CARSConfig | undefined {
    const all = listAllConfigs(info);
    const index = parseInt(nameOrIndex, 10);
    if (!isNaN(index) && index >= 0 && index < all.length) {
        return all[index];
    }
    return all.find(c => c.name === nameOrIndex);
}

/**
 * Helper to choose a CARS config interactively if not provided.
 */
async function pickCARSConfig(info: CARSConfigInfo, nameOrIndex?: string): Promise<CARSConfig> {
    const all = listAllConfigs(info);
    const carsConfigs = all.filter(isCARSConfig);

    if (nameOrIndex) {
        const cfg = findConfigByNameOrIndex(info, nameOrIndex);
        if (!cfg) {
            console.error(chalk.red(`❌ Configuration "${nameOrIndex}" not found.`));
            process.exit(1);
        }
        if (!isCARSConfig(cfg)) {
            console.error(chalk.red(`❌ Configuration "${nameOrIndex}" is not a CARS configuration.`));
            process.exit(1);
        }
        return cfg;
    }

    if (carsConfigs.length === 0) {
        console.log(chalk.yellow('No CARS configurations found. Let’s create one.'));
        const newCfg = await addCARSConfigInteractive(info);
        return newCfg;
    }

    const choices = carsConfigs.map((c, i) => {
        const indexInAll = all.indexOf(c);
        return {
            name: `${indexInAll}: ${c.name} (CloudURL: ${c.CARSCloudURL}, ProjectID: ${c.projectID || 'none'})`,
            value: indexInAll
        };
    });

    const { chosenIndex } = await inquirer.prompt([
        {
            type: 'list',
            name: 'chosenIndex',
            message: 'Select a CARS configuration:',
            choices
        }
    ]);

    return all[chosenIndex];
}

async function ensureRegistered(carsConfig: CARSConfig) {
    if (!carsConfig.CARSCloudURL) {
        console.error(chalk.red('❌ No CARS Cloud URL set in the chosen configuration.'));
        process.exit(1);
    }
    const client = new AuthriteClient(carsConfig.CARSCloudURL);
    try {
        await client.createSignedRequest('/api/v1/register', {});
    } catch (error: any) {
        handleRequestError(error, 'Registration failed');
        process.exit(1);
    }
}

/**
 * Project and Config Setup Helpers
 */

async function chooseOrCreateProjectID(cloudUrl: string, currentProjectID?: string): Promise<string> {
    const client = new AuthriteClient(cloudUrl);
    await ensureRegistered({ provider: 'CARS', CARSCloudURL: cloudUrl, name: 'CARS' });

    const { action } = await inquirer.prompt([
        {
            type: 'list',
            name: 'action',
            message: 'Project ID configuration:',
            choices: [
                { name: 'Use existing project ID', value: 'existing' },
                { name: 'Create a new project on this CARS Cloud', value: 'new' }
            ],
            default: currentProjectID ? 'existing' : 'new'
        }
    ]);

    if (action === 'existing') {
        const { projectID } = await inquirer.prompt([
            {
                type: 'input',
                name: 'projectID',
                message: 'Enter existing Project ID:',
                default: currentProjectID,
                validate: (val: string) => val.trim() ? true : 'Project ID is required.'
            }
        ]);

        // Validate project ID by listing projects
        let projects;
        try {
            projects = await client.createSignedRequest('/api/v1/projects/list', {});
        } catch (error: any) {
            handleRequestError(error, 'Failed to retrieve projects from CARS Cloud.');
            process.exit(1);
        }

        if (!projects || !Array.isArray(projects.projects)) {
            console.error(chalk.red('❌ Invalid response from CARS Cloud when checking projects.'));
            process.exit(1);
        }
        // Check if the projectID is indeed in the returned list. The backend returns { projects: [projectIds] }.
        if (!projects.projects.includes(projectID.trim())) {
            console.error(chalk.red(`❌ Project ID "${projectID}" not found on server ${cloudUrl}.`));
            process.exit(1);
        }
        return projectID.trim();
    } else {
        // Create new project
        let result;
        try {
            result = await client.createSignedRequest('/api/v1/project/create', {});
        } catch (error: any) {
            handleRequestError(error, 'Failed to create new project.');
            process.exit(1);
        }

        if (!result.projectId) {
            console.error(chalk.red('❌ Failed to create new project. No projectId returned.'));
            process.exit(1);
        }
        console.log(chalk.green(`✅ New project created with ID: ${result.projectId}`));
        return result.projectId;
    }
}

/**
 * Interactive editing of configurations
 */
async function addCARSConfigInteractive(info: CARSConfigInfo): Promise<CARSConfig> {
    const cloudChoices = [
        { name: 'localhost:7777', value: 'http://localhost:7777' },
        { name: 'cars-cloud1.com', value: 'https://cars-cloud1.com' },
        { name: 'cars-cloud2.com', value: 'https://cars-cloud2.com' },
        { name: 'cars-cloud3.com', value: 'https://cars-cloud3.com' },
        { name: 'Custom', value: 'custom' }
    ];

    const { name, cloudUrlChoice, customCloudUrl, network, deployTargets, frontendHosting } = await inquirer.prompt([
        {
            type: 'input',
            name: 'name',
            message: 'Name of this CARS configuration:',
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
            name: 'network',
            message: 'Network (e.g. testnet/mainnet):',
            default: 'mainnet'
        },
        {
            type: 'checkbox',
            name: 'deployTargets',
            message: 'Select what to release with this config:',
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
    const projectID = await chooseOrCreateProjectID(finalCloudUrl);

    const newCfg: CARSConfig = {
        name,
        provider: 'CARS',
        CARSCloudURL: finalCloudUrl,
        projectID: projectID,
        network: network.trim(),
        deploy: deployTargets,
        frontendHostingMethod: frontendHosting === 'none' ? undefined : frontendHosting
    };

    info.configs = info.configs || [];
    info.configs.push(newCfg);
    saveCARSConfigInfo(info);

    // Attempt registration
    await ensureRegistered(newCfg);

    console.log(chalk.green(`✅ CARS configuration "${name}" created.`));
    return newCfg;
}

async function editCARSConfigInteractive(info: CARSConfigInfo, config: CARSConfig) {
    const cloudChoices = [
        { name: 'localhost:7777', value: 'http://localhost:7777' },
        { name: 'cars-cloud1.com', value: 'https://cars-cloud1.com' },
        { name: 'cars-cloud2.com', value: 'https://cars-cloud2.com' },
        { name: 'cars-cloud3.com', value: 'https://cars-cloud3.com' },
        { name: 'Custom', value: 'custom' }
    ];

    const currentCloudChoice = cloudChoices.find(ch => ch.value === config.CARSCloudURL) ? config.CARSCloudURL : 'custom';

    const { name, cloudUrlChoice, customCloudUrl, network, deployTargets, frontendHosting } = await inquirer.prompt([
        {
            type: 'input',
            name: 'name',
            message: 'Configuration name:',
            default: config.name,
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
            default: config.CARSCloudURL || 'http://localhost:7777'
        },
        {
            type: 'input',
            name: 'network',
            message: 'Network:',
            default: config.network || 'testnet'
        },
        {
            type: 'checkbox',
            name: 'deployTargets',
            message: 'What to release?',
            choices: [
                { name: 'frontend', value: 'frontend', checked: config.deploy?.includes('frontend') },
                { name: 'backend', value: 'backend', checked: config.deploy?.includes('backend') },
            ]
        },
        {
            type: 'list',
            name: 'frontendHosting',
            message: 'Frontend hosting method:',
            choices: ['HTTPS', 'UHRP', 'none'],
            when: ans => ans.deployTargets.includes('frontend'),
            default: config.frontendHostingMethod || 'none'
        }
    ]);

    const finalCloudUrl = cloudUrlChoice === 'custom' ? customCloudUrl : cloudUrlChoice;
    const projectID = await chooseOrCreateProjectID(finalCloudUrl, config.projectID);

    config.name = name.trim();
    config.CARSCloudURL = finalCloudUrl;
    config.projectID = projectID;
    config.network = network.trim();
    config.deploy = deployTargets;
    config.frontendHostingMethod = frontendHosting === 'none' ? undefined : frontendHosting;

    saveCARSConfigInfo(info);

    await ensureRegistered(config);

    console.log(chalk.green(`✅ CARS configuration "${name}" updated.`));
}

function deleteCARSConfig(info: CARSConfigInfo, config: CARSConfig) {
    info.configs = (info.configs || []).filter(c => c !== config);
    saveCARSConfigInfo(info);
    console.log(chalk.green(`✅ CARS configuration "${config.name}" deleted.`));
}

/**
 * Build logic
 */

async function buildArtifact() {
    if (!fs.existsSync(CONFIG_PATH)) {
        console.error(chalk.red('❌ No deployment-info.json found in current directory.'));
        process.exit(1);
    }
    const carsConfigInfo: CARSConfigInfo = loadCARSConfigInfo();
    if (carsConfigInfo.schema !== 'bsv-app') {
        console.error(chalk.red('❌ Invalid schema in deployment-info.json'));
        process.exit(1);
    }

    console.log(chalk.blue('🛠  Building local project artifact...'));
    const artifactName = `${ARTIFACT_PREFIX}${Date.now()}${ARTIFACT_EXTENSION}`;
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

function findArtifacts(): string[] {
    return fs.readdirSync(process.cwd()).filter(f => f.startsWith(ARTIFACT_PREFIX) && f.endsWith(ARTIFACT_EXTENSION));
}

function findLatestArtifact(): string {
    const artifacts = findArtifacts();
    const found = artifacts.sort().pop();
    if (!found) {
        console.error(chalk.red('❌ No artifact found. Run `cars build` first.'));
        process.exit(1);
    }
    return found;
}

/**
 * Helper for Authrite requests with nice error handling
 */

async function safeRequest<T = any>(client: AuthriteClient, endpoint: string, data: any): Promise<T | undefined> {
    try {
        return await client.createSignedRequest<T>(endpoint, data);
    } catch (error: any) {
        handleRequestError(error, `Request to ${endpoint} failed`);
        return undefined;
    }
}

/**
 * Error handling
 */
function handleRequestError(error: any, contextMsg?: string) {
    if (contextMsg) console.error(chalk.red(`❌ ${contextMsg}`));
    if (error?.response?.data?.error) {
        console.error(chalk.red(`Error from server: ${error.response.data.error}`));
    } else if (error.message) {
        console.error(chalk.red(`Error: ${error.message}`));
    } else {
        console.error(chalk.red('An unknown error occurred.'));
    }
}

/**
 * Data formatting for output
 */
function printProjectList(projects: string[]) {
    if (!projects || projects.length === 0) {
        console.log(chalk.yellow('No projects found.'));
        return;
    }
    const table = new Table({ head: ['Project IDs'] });
    projects.forEach(p => table.push([p]));
    console.log(table.toString());
}

function printAdminsList(admins: string[]) {
    if (!admins || admins.length === 0) {
        console.log(chalk.yellow('No admins found.'));
        return;
    }
    const table = new Table({ head: ['Admin Identity Keys'] });
    admins.forEach(a => table.push([a]));
    console.log(table.toString());
}

function printProjectLog(log: string) {
    console.log(chalk.blue('Project Log:'));
    console.log(log.trim() || chalk.yellow('No logs yet.'));
}

function printReleasesList(releases: string[]) {
    if (!releases || releases.length === 0) {
        console.log(chalk.yellow('No releases found.'));
        return;
    }
    const table = new Table({ head: ['Release IDs'] });
    releases.forEach(r => table.push([r]));
    console.log(table.toString());
}

function printReleaseLog(log: string) {
    console.log(chalk.blue('Release Log:'));
    console.log(log.trim() || chalk.yellow('No logs yet.'));
}

function printArtifactsList() {
    const artifacts = findArtifacts();
    if (artifacts.length === 0) {
        console.log(chalk.yellow('No artifacts found.'));
        return;
    }
    const table = new Table({ head: ['Artifact File', 'Created Time'] });
    artifacts.forEach(a => {
        const tsStr = a.substring(ARTIFACT_PREFIX.length, a.length - ARTIFACT_EXTENSION.length);
        const ts = parseInt(tsStr, 10);
        const date = new Date(ts);
        table.push([a, date.toLocaleString()]);
    });
    console.log(table.toString());
}

/**
 * Distinct CARS Cloud URLs
 */
function getDistinctCARSCloudURLs(info: CARSConfigInfo): string[] {
    const urls = (info.configs || [])
        .filter(isCARSConfig)
        .map(c => c.CARSCloudURL as string)
        .filter(u => !!u);
    return Array.from(new Set(urls));
}

async function chooseCARSCloudURL(info: CARSConfigInfo, specifiedNameOrIndex?: string): Promise<string> {
    if (specifiedNameOrIndex) {
        const cfg = findConfigByNameOrIndex(info, specifiedNameOrIndex);
        if (!cfg) {
            console.error(chalk.red(`❌ Configuration "${specifiedNameOrIndex}" not found.`));
            process.exit(1);
        }
        if (!isCARSConfig(cfg)) {
            console.error(chalk.red(`❌ Configuration "${specifiedNameOrIndex}" is not a CARS configuration.`));
            process.exit(1);
        }
        if (!cfg.CARSCloudURL) {
            console.error(chalk.red('❌ This CARS configuration has no CARSCloudURL set.'));
            process.exit(1);
        }
        return cfg.CARSCloudURL;
    }

    const urls = getDistinctCARSCloudURLs(info);
    if (urls.length === 0) {
        console.error(chalk.red('❌ No CARS Cloud configurations found in deployment-info.json.'));
        process.exit(1);
    }
    if (urls.length === 1) {
        return urls[0];
    }

    const { chosenURL } = await inquirer.prompt([
        {
            type: 'list',
            name: 'chosenURL',
            message: 'Select a CARS Cloud server:',
            choices: urls
        }
    ]);

    return chosenURL;
}

async function getAuthriteClientForConfig(config: CARSConfig) {
    if (!config.CARSCloudURL) {
        console.error(chalk.red('❌ CARSCloudURL not set on this configuration.'));
        process.exit(1);
    }
    await ensureRegistered(config);
    return new AuthriteClient(config.CARSCloudURL);
}

/**
 * Interactive Menus
 */

async function mainMenu() {
    const info = loadCARSConfigInfo();
    const carsConfigs = info.configs?.filter(isCARSConfig) || [];

    const choices = [
        { name: 'Manage CARS Configurations', value: 'config' },
        { name: 'Manage Projects', value: 'project' },
        { name: 'Manage Releases', value: 'release' },
        { name: 'Manage Artifacts', value: 'artifact' },
        { name: 'Build Artifact', value: 'build' },
        { name: 'Exit', value: 'exit' }
    ];

    let done = false;
    while (!done) {
        const { action } = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: 'Main Menu',
                choices
            }
        ]);

        if (action === 'config') {
            await configMenu();
        } else if (action === 'project') {
            await projectMenu();
        } else if (action === 'release') {
            await releaseMenu();
        } else if (action === 'artifact') {
            await artifactMenu();
        } else if (action === 'build') {
            await buildArtifact();
        } else {
            done = true;
        }
    }
}

async function configMenu() {
    const info = loadCARSConfigInfo();
    const all = listAllConfigs(info);
    const carsConfigs = all.filter(isCARSConfig);

    const baseChoices = [
        { name: 'List all configurations', value: 'ls' },
        { name: 'Add a new CARS configuration', value: 'add' },
    ];

    if (carsConfigs.length > 0) {
        baseChoices.push({ name: 'Edit an existing CARS configuration', value: 'edit' });
        baseChoices.push({ name: 'Delete a CARS configuration', value: 'delete' });
    }

    baseChoices.push({ name: 'Back to main menu', value: 'back' });

    let done = false;
    while (!done) {
        const { action } = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: 'CARS Configurations Menu',
                choices: baseChoices
            }
        ]);

        if (action === 'ls') {
            printAllConfigsWithIndex(loadCARSConfigInfo());
        } else if (action === 'add') {
            const updatedInfo = loadCARSConfigInfo();
            await addCARSConfigInteractive(updatedInfo);
        } else if (action === 'edit') {
            const updatedInfo = loadCARSConfigInfo();
            const cars = updatedInfo.configs!.filter(isCARSConfig);
            if (cars.length === 0) {
                console.log(chalk.yellow('No CARS configurations to edit.'));
            } else {
                const { chosenIndex } = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'chosenIndex',
                        message: 'Select a CARS configuration to edit:',
                        choices: cars.map(c => {
                            const idx = updatedInfo.configs!.indexOf(c);
                            return {
                                name: `${idx}: ${c.name} (CARSCloudURL: ${c.CARSCloudURL})`,
                                value: idx
                            };
                        })
                    }
                ]);
                const cfgToEdit = updatedInfo.configs![chosenIndex];
                await editCARSConfigInteractive(updatedInfo, cfgToEdit);
            }
        } else if (action === 'delete') {
            const updatedInfo = loadCARSConfigInfo();
            const cars = updatedInfo.configs!.filter(isCARSConfig);
            if (cars.length === 0) {
                console.log(chalk.yellow('No CARS configurations to delete.'));
            } else {
                const { chosenIndex } = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'chosenIndex',
                        message: 'Select a CARS configuration to delete:',
                        choices: cars.map(c => {
                            const idx = updatedInfo.configs!.indexOf(c);
                            return {
                                name: `${idx}: ${c.name} (CARSCloudURL: ${c.CARSCloudURL})`,
                                value: idx
                            };
                        })
                    }
                ]);
                deleteCARSConfig(updatedInfo, updatedInfo.configs![chosenIndex]);
            }
        } else {
            done = true;
        }
    }
}

async function projectMenu() {
    const info = loadCARSConfigInfo();

    const choices = [
        { name: 'List Projects', value: 'ls' },
        { name: 'Add Admin to a Project', value: 'add-admin' },
        { name: 'Remove Admin from a Project', value: 'remove-admin' },
        { name: 'List Admins of a Project', value: 'list-admins' },
        { name: 'View Project Logs', value: 'logs' },
        { name: 'View Releases for a Project', value: 'releases' },
        { name: 'Back to main menu', value: 'back' }
    ];

    let done = false;
    while (!done) {
        const { action } = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: 'Project Management Menu',
                choices
            }
        ]);

        if (action === 'ls') {
            const chosenURL = await chooseCARSCloudURL(info);
            const client = new AuthriteClient(chosenURL);
            await ensureRegistered({ provider: 'CARS', CARSCloudURL: chosenURL, name: 'CARS' });
            let result;
            try {
                result = await client.createSignedRequest('/api/v1/projects/list', {});
            } catch (e: any) {
                handleRequestError(e, 'Failed to list projects');
            }
            if (result && Array.isArray(result.projects)) {
                printProjectList(result.projects);
            }
        } else if (action === 'add-admin') {
            const config = await pickCARSConfig(info);
            if (!config.projectID) {
                console.error(chalk.red('❌ No project ID set in this configuration.'));
                continue;
            }
            const { identityKey } = await inquirer.prompt([
                { type: 'input', name: 'identityKey', message: 'Enter Identity Key of the user to add as admin:' }
            ]);
            const client = await getAuthriteClientForConfig(config);
            const result = await safeRequest(client, `/api/v1/project/${config.projectID}/addAdmin`, { identityKey });
            if (result) {
                console.log(chalk.green('✅ Admin added successfully.'));
            }
        } else if (action === 'remove-admin') {
            const config = await pickCARSConfig(info);
            if (!config.projectID) {
                console.error(chalk.red('❌ No project ID set in this configuration.'));
                continue;
            }
            const { identityKey } = await inquirer.prompt([
                { type: 'input', name: 'identityKey', message: 'Enter Identity Key of the admin to remove:' }
            ]);
            const client = await getAuthriteClientForConfig(config);
            const result = await safeRequest(client, `/api/v1/project/${config.projectID}/removeAdmin`, { identityKey });
            if (result) {
                console.log(chalk.green('✅ Admin removed successfully.'));
            }
        } else if (action === 'list-admins') {
            const config = await pickCARSConfig(info);
            if (!config.projectID) {
                console.error(chalk.red('❌ No project ID set in this configuration.'));
                continue;
            }
            const client = await getAuthriteClientForConfig(config);
            const result = await safeRequest<{ admins: string[] }>(client, `/api/v1/project/${config.projectID}/admins/list`, {});
            if (result && result.admins) {
                printAdminsList(result.admins);
            }
        } else if (action === 'logs') {
            const config = await pickCARSConfig(info);
            if (!config.projectID) {
                console.error(chalk.red('❌ No project ID set in this configuration.'));
                continue;
            }
            const client = await getAuthriteClientForConfig(config);
            const result = await safeRequest<{ logs: string }>(client, `/api/v1/project/${config.projectID}/logs/show`, {});
            if (result && typeof result.logs === 'string') {
                printProjectLog(result.logs);
            }
        } else if (action === 'releases') {
            const config = await pickCARSConfig(info);
            if (!config.projectID) {
                console.error(chalk.red('❌ No project ID set in this configuration.'));
                continue;
            }
            const client = await getAuthriteClientForConfig(config);
            const result = await safeRequest<{ deploys: string[] }>(client, `/api/v1/project/${config.projectID}/deploys/list`, {});
            if (result && Array.isArray(result.deploys)) {
                printReleasesList(result.deploys);
            }
        } else {
            done = true;
        }
    }
}

async function releaseMenu() {
    const info = loadCARSConfigInfo();

    const choices = [
        { name: 'Create new release (get upload URL)', value: 'get-upload-url' },
        { name: 'Upload artifact to a release URL', value: 'upload-files' },
        { name: 'View release logs', value: 'logs' },
        { name: 'Create and upload latest artifact now', value: 'now' },
        { name: 'Back to main menu', value: 'back' }
    ];

    let done = false;
    while (!done) {
        const { action } = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: 'Release Management Menu',
                choices
            }
        ]);

        if (action === 'get-upload-url') {
            const config = await pickCARSConfig(info);
            if (!config.projectID) {
                console.error(chalk.red('❌ No project ID set in this configuration.'));
                continue;
            }
            const client = await getAuthriteClientForConfig(config);
            const result = await safeRequest<{ url: string, deploymentId: string }>(client, `/api/v1/project/${config.projectID}/deploy`, {});
            if (result && result.url && result.deploymentId) {
                console.log(chalk.green(`✅ Release created. Release ID: ${result.deploymentId}`));
                console.log(`Upload URL: ${result.url}`);
            }
        } else if (action === 'upload-files') {
            const { uploadURL } = await inquirer.prompt([
                { type: 'input', name: 'uploadURL', message: 'Enter the upload URL:' }
            ]);
            const { artifactPath } = await inquirer.prompt([
                { type: 'input', name: 'artifactPath', message: 'Enter the path to the artifact:' }
            ]);
            await uploadArtifact(uploadURL, artifactPath);
        } else if (action === 'logs') {
            const config = await pickCARSConfig(info);
            const { releaseId } = await inquirer.prompt([
                { type: 'input', name: 'releaseId', message: 'Enter the Release ID:' }
            ]);
            const client = await getAuthriteClientForConfig(config);
            const result = await safeRequest<{ logs: string }>(client, `/api/v1/deploy/${releaseId}/logs/show`, {});
            if (result && typeof result.logs === 'string') {
                printReleaseLog(result.logs);
            }
        } else if (action === 'now') {
            // Build and upload latest artifact directly
            const config = await pickCARSConfig(info);
            if (!config.projectID) {
                console.error(chalk.red('❌ No project ID set in this configuration.'));
                continue;
            }

            const artifactPath = findLatestArtifact();
            const client = await getAuthriteClientForConfig(config);
            const result = await safeRequest<{ url: string, deploymentId: string }>(client, `/api/v1/project/${config.projectID}/deploy`, {});
            if (result && result.url && result.deploymentId) {
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
                    handleRequestError(error);
                }
            }
        } else {
            done = true;
        }
    }
}

async function artifactMenu() {
    const choices = [
        { name: 'List Artifacts', value: 'ls' },
        { name: 'Delete an Artifact', value: 'delete' },
        { name: 'Back to main menu', value: 'back' }
    ];

    let done = false;
    while (!done) {
        const { action } = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: 'Artifact Management Menu',
                choices
            }
        ]);

        if (action === 'ls') {
            printArtifactsList();
        } else if (action === 'delete') {
            const artifacts = findArtifacts();
            if (artifacts.length === 0) {
                console.log(chalk.yellow('No artifacts found to delete.'));
            } else {
                const { chosenFile } = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'chosenFile',
                        message: 'Select an artifact to delete:',
                        choices: artifacts
                    }
                ]);
                fs.unlinkSync(chosenFile);
                console.log(chalk.green(`✅ Artifact "${chosenFile}" deleted.`));
            }
        } else {
            done = true;
        }
    }
}

/**
 * Upload Artifact Helper
 */
async function uploadArtifact(uploadURL: string, artifactPath: string) {
    if (!fs.existsSync(artifactPath)) {
        console.error(chalk.red(`❌ Artifact not found: ${artifactPath}`));
        return;
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
        handleRequestError(error);
    }
}

/**
 * CLI Definition
 */

// cars config <subcommands>
const configCommand = program
    .command('config')
    .description('Manage CARS configurations in deployment-info.json');

configCommand
    .command('ls')
    .description('List all configurations (CARS and non-CARS)')
    .action(() => {
        const info = loadCARSConfigInfo();
        printAllConfigsWithIndex(info);
    });

configCommand
    .command('add')
    .description('Add a new CARS configuration')
    .action(async () => {
        const info = loadCARSConfigInfo();
        await addCARSConfigInteractive(info);
    });

configCommand
    .command('edit <nameOrIndex>')
    .description('Edit a CARS configuration')
    .action(async (nameOrIndex) => {
        const info = loadCARSConfigInfo();
        const cfg = findConfigByNameOrIndex(info, nameOrIndex);
        if (!cfg) {
            console.error(chalk.red(`❌ Configuration "${nameOrIndex}" not found.`));
            process.exit(1);
        }
        if (!isCARSConfig(cfg)) {
            console.error(chalk.red(`❌ Configuration "${nameOrIndex}" is not a CARS configuration.`));
            process.exit(1);
        }
        await editCARSConfigInteractive(info, cfg);
    });

configCommand
    .command('delete <nameOrIndex>')
    .description('Delete a configuration')
    .action((nameOrIndex) => {
        const info = loadCARSConfigInfo();
        const cfg = findConfigByNameOrIndex(info, nameOrIndex);
        if (!cfg) {
            console.error(chalk.red(`❌ Configuration "${nameOrIndex}" not found.`));
            process.exit(1);
        }
        if (!isCARSConfig(cfg)) {
            console.error(chalk.red(`❌ Configuration "${nameOrIndex}" is not a CARS configuration.`));
            process.exit(1);
        }
        deleteCARSConfig(info, cfg);
    });

configCommand
    .action(async () => {
        // If `cars config` was run without subcommands, show the config menu
        await configMenu();
    });

// build
program
    .command('build')
    .description('Build local artifact for release')
    .action(async () => {
        await buildArtifact();
    });

// project <subcommands>
const projectCommand = program
    .command('project')
    .description('Manage projects via CARS');

projectCommand
    .command('ls [nameOrIndex]')
    .description('List all projects on a chosen CARS Cloud server')
    .action(async (nameOrIndex) => {
        const info = loadCARSConfigInfo();
        const chosenURL = await chooseCARSCloudURL(info, nameOrIndex);
        const client = new AuthriteClient(chosenURL);
        await ensureRegistered({ provider: 'CARS', CARSCloudURL: chosenURL, name: 'CARS' });
        let result;
        try {
            result = await client.createSignedRequest('/api/v1/projects/list', {});
        } catch (e: any) {
            handleRequestError(e, 'Failed to list projects');
            process.exit(1);
        }
        printProjectList(result.projects);
    });

projectCommand
    .command('add-admin <identityKey> [nameOrIndex]')
    .description('Add an admin to the project of the chosen configuration')
    .action(async (identityKey, nameOrIndex) => {
        const info = loadCARSConfigInfo();
        const cfg = await pickCARSConfig(info, nameOrIndex);
        if (!cfg.projectID) {
            console.error(chalk.red('❌ No project ID set in this configuration.'));
            process.exit(1);
        }
        const client = await getAuthriteClientForConfig(cfg);
        const result = await safeRequest(client, `/api/v1/project/${cfg.projectID}/addAdmin`, { identityKey });
        if (result) console.log(chalk.green('✅ Admin added.'));
    });

projectCommand
    .command('remove-admin <identityKey> [nameOrIndex]')
    .description('Remove an admin from the project of the chosen configuration')
    .action(async (identityKey, nameOrIndex) => {
        const info = loadCARSConfigInfo();
        const cfg = await pickCARSConfig(info, nameOrIndex);
        if (!cfg.projectID) {
            console.error(chalk.red('❌ No project ID set in this configuration.'));
            process.exit(1);
        }
        const client = await getAuthriteClientForConfig(cfg);
        const result = await safeRequest(client, `/api/v1/project/${cfg.projectID}/removeAdmin`, { identityKey });
        if (result) console.log(chalk.green('✅ Admin removed.'));
    });

projectCommand
    .command('list-admins [nameOrIndex]')
    .description('List the admins for the project of the chosen configuration')
    .action(async (nameOrIndex) => {
        const info = loadCARSConfigInfo();
        const cfg = await pickCARSConfig(info, nameOrIndex);
        if (!cfg.projectID) {
            console.error(chalk.red('❌ No project ID set in this configuration.'));
            process.exit(1);
        }
        const client = await getAuthriteClientForConfig(cfg);
        const result = await safeRequest<{ admins: string[] }>(client, `/api/v1/project/${cfg.projectID}/admins/list`, {});
        if (result) printAdminsList(result.admins);
    });

projectCommand
    .command('logs [nameOrIndex]')
    .description('View logs of the project from the chosen configuration')
    .action(async (nameOrIndex) => {
        const info = loadCARSConfigInfo();
        const cfg = await pickCARSConfig(info, nameOrIndex);
        if (!cfg.projectID) {
            console.error(chalk.red('❌ No project ID set in this configuration.'));
            process.exit(1);
        }
        const client = await getAuthriteClientForConfig(cfg);
        const result = await safeRequest<{ logs: string }>(client, `/api/v1/project/${cfg.projectID}/logs/show`, {});
        if (result) printProjectLog(result.logs);
    });

projectCommand
    .command('releases [nameOrIndex]')
    .description('List all releases for the project from the chosen configuration')
    .action(async (nameOrIndex) => {
        const info = loadCARSConfigInfo();
        const cfg = await pickCARSConfig(info, nameOrIndex);
        if (!cfg.projectID) {
            console.error(chalk.red('❌ No project ID set in this configuration.'));
            process.exit(1);
        }
        const client = await getAuthriteClientForConfig(cfg);
        const result = await safeRequest<{ deploys: string[] }>(client, `/api/v1/project/${cfg.projectID}/deploys/list`, {});
        if (result && Array.isArray(result.deploys)) printReleasesList(result.deploys);
    });

projectCommand
    .action(async () => {
        // If `cars project` is run without subcommands, show project menu
        await projectMenu();
    });

// release <subcommands>
const releaseCommand = program
    .command('release')
    .description('Manage releases via CARS');

releaseCommand
    .command('get-upload-url [nameOrIndex]')
    .description('Create a new release for a chosen CARS configuration and get the upload URL')
    .action(async (nameOrIndex) => {
        const info = loadCARSConfigInfo();
        const cfg = await pickCARSConfig(info, nameOrIndex);

        if (!cfg.projectID) {
            console.error(chalk.red('❌ No project ID set in this configuration.'));
            process.exit(1);
        }
        const client = await getAuthriteClientForConfig(cfg);
        const result = await safeRequest<{ url: string, deploymentId: string }>(client, `/api/v1/project/${cfg.projectID}/deploy`, {});
        if (result && result.url && result.deploymentId) {
            console.log(chalk.green(`✅ Release created. Release ID: ${result.deploymentId}`));
            console.log(`Upload URL: ${result.url}`);
        }
    });

releaseCommand
    .command('upload-files <uploadURL> <artifactPath>')
    .description('Upload a built artifact to the given URL')
    .action(async (uploadURL, artifactPath) => {
        await uploadArtifact(uploadURL, artifactPath);
    });

releaseCommand
    .command('logs <releaseId> [nameOrIndex]')
    .description('View logs of a release by its ID')
    .action(async (releaseId, nameOrIndex) => {
        const info = loadCARSConfigInfo();
        const cfg = await pickCARSConfig(info, nameOrIndex);
        const client = await getAuthriteClientForConfig(cfg);
        const result = await safeRequest<{ logs: string }>(client, `/api/v1/deploy/${releaseId}/logs/show`, {});
        if (result && typeof result.logs === 'string') {
            printReleaseLog(result.logs);
        }
    });

releaseCommand
    .command('now [nameOrIndex]')
    .description('Upload the latest artifact directly to the chosen CARS configuration as a new release')
    .action(async (nameOrIndex) => {
        const info = loadCARSConfigInfo();
        const cfg = await pickCARSConfig(info, nameOrIndex);

        if (!cfg.projectID) {
            console.error(chalk.red('❌ No project ID set in this configuration.'));
            process.exit(1);
        }

        const artifactPath = findLatestArtifact();
        const client = await getAuthriteClientForConfig(cfg);
        const result = await safeRequest<{ url: string, deploymentId: string }>(client, `/api/v1/project/${cfg.projectID}/deploy`, {});
        if (result && result.url && result.deploymentId) {
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
                handleRequestError(error);
            }
        }
    });

releaseCommand
    .action(async () => {
        // If `cars release` is run without subcommands, show release menu
        await releaseMenu();
    });

// artifact <subcommands>
const artifactCommand = program
    .command('artifact')
    .description('Manage CARS artifacts');

artifactCommand
    .command('ls')
    .description('List all local artifacts')
    .action(() => {
        printArtifactsList();
    });

artifactCommand
    .command('delete <artifactName>')
    .description('Delete a local artifact')
    .action((artifactName) => {
        const artifacts = findArtifacts();
        if (!artifacts.includes(artifactName)) {
            console.error(chalk.red(`❌ Artifact "${artifactName}" not found.`));
            process.exit(1);
        }
        fs.unlinkSync(artifactName);
        console.log(chalk.green(`✅ Artifact "${artifactName}" deleted.`));
    });

artifactCommand
    .action(async () => {
        // If `cars artifact` is run without subcommands, show artifact menu
        await artifactMenu();
    });

/**
 * If `cars` is invoked without args, enter the main menu.
 * If there are no CARS configs yet, walk through creation first.
 */

(async function main() {
    if (process.argv.length <= 2) {
        // No arguments provided
        let info: CARSConfigInfo;
        if (!fs.existsSync(CONFIG_PATH)) {
            console.log(chalk.yellow('No deployment-info.json found. Creating a basic one.'));
            const basicInfo: CARSConfigInfo = {
                schema: 'bsv-app',
                schemaVersion: '1.0'
            };
            saveCARSConfigInfo(basicInfo);
        }

        info = loadCARSConfigInfo();
        if ((info.configs || []).filter(isCARSConfig).length === 0) {
            console.log(chalk.yellow('No CARS configurations found. Let’s create one.'));
            await addCARSConfigInteractive(info);
        }

        // Now enter main menu
        await mainMenu();
    } else {
        program.parse(process.argv);
    }
})();
