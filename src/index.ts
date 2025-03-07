#!/usr/bin/env node
import { program } from 'commander';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import * as tar from 'tar';
import { spawnSync } from 'child_process';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { AuthFetch, WalletClient } from '@bsv/sdk';
import ora from 'ora';
import Table from 'cli-table3';

// Set up an RNG
import * as crypto from 'crypto'
global.self = { crypto } as any

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
    configs?: CARSConfig[];
}

interface CARSConfig {
    name: string;
    network?: string;
    provider: string; // "CARS", "LARS" or another provider
    projectID?: string;
    CARSCloudURL?: string;
    deploy?: string[]; // which parts to release: "frontend", "backend"
    frontendHostingMethod?: string;
    authentication?: any;
    payments?: any;
}

interface ProjectInfo {
    id: string;
    name: string;
    network: string;
    status: {
        online: boolean;
        lastChecked: string;
        domains: { frontend?: string; backend?: string; ssl: boolean };
        deploymentId: string | null;
    };
    billing: {
        balance: number;
    };
    sslEnabled: boolean;
    customDomains: {
        frontend?: string;
        backend?: string;
    };
    webUIConfig: any;
}

interface ProjectListing {
    id: string;
    name: string;
    balance: string;
    created_at: string;
    network: 'mainnet' | 'testnet';
}

interface AdminInfo {
    identity_key: string;
    email: string;
    added_at: string;
}

interface DeployInfo {
    deployment_uuid: string;
    created_at: string;
}

interface AccountingRecord {
    id: number;
    project_id: number;
    deploy_id?: number;
    timestamp: string;
    type: 'credit' | 'debit';
    metadata: any;
    amount_sats: string;
    balance_after: string;
}

const CONFIG_PATH = path.resolve(process.cwd(), 'deployment-info.json');
const ARTIFACT_PREFIX = 'cars_artifact_';
const ARTIFACT_EXTENSION = '.tgz';
const VALID_LOG_PERIODS = ['5m', '15m', '30m', '1h', '2h', '6h', '12h', '1d', '2d', '7d'] as const;
const VALID_LOG_LEVELS = ['all', 'error', 'warn', 'info'] as const;

type LogPeriod = typeof VALID_LOG_PERIODS[number];
type LogLevel = typeof VALID_LOG_LEVELS[number];

function isValidLogPeriod(period: string): period is LogPeriod {
    return VALID_LOG_PERIODS.includes(period as LogPeriod);
}

function isValidLogLevel(level: string): level is LogLevel {
    return VALID_LOG_LEVELS.includes(level as LogLevel);
}

const MAX_TAIL_LINES = 10000;

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
    const table = new Table({ head: ['Index', 'Name', 'Provider', 'CARSCloudURL', 'ProjectID', 'Network'] });
    all.forEach((c, i) => {
        table.push([i.toString(), c.name, c.provider, c.CARSCloudURL || '', c.projectID || 'none', c.network || '']);
    });
    console.log(table.toString());
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

    const choices = carsConfigs.map((c) => {
        const idx = all.indexOf(c);
        return {
            name: `${idx}: ${c.name} (CloudURL: ${c.CARSCloudURL}, ProjectID: ${c.projectID || 'none'})`,
            value: idx
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
    const client = new AuthFetch(new WalletClient('auto', 'localhost'));
    try {
        const response = await client.fetch(`${carsConfig.CARSCloudURL}/api/v1/register`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: '{}'
        });
        await response.json()
    } catch (error: any) {
        handleRequestError(error, 'Registration failed');
        process.exit(1);
    }
}

/**
 * Project and Config Setup Helpers
 */

async function chooseOrCreateProjectID(cloudUrl: string, currentProjectID?: string, network = 'mainnet'): Promise<string> {
    const client = new AuthFetch(new WalletClient('auto', 'localhost'));
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

        let projects: { projects: ProjectListing[] };
        try {
            let response = await client.fetch(`${cloudUrl}/api/v1/project/list`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json'
                },
                body: '{}'
            });
            projects = await response.json();
        } catch (error: any) {
            handleRequestError(error, 'Failed to retrieve projects from CARS Cloud.');
            process.exit(1);
        }

        if (!projects || !Array.isArray(projects.projects)) {
            console.error(chalk.red('❌ Invalid response from CARS Cloud when checking projects.'));
            process.exit(1);
        }

        if (!projects.projects.some(x => x.network === network && x.id === projectID.trim())) {
            console.error(chalk.red(`❌ Project ID "${projectID}" not found on ${network} at server ${cloudUrl}.`));
            process.exit(1);
        }
        return projectID.trim();
    } else {
        const { name } = await inquirer.prompt([
            {
                type: 'input',
                name: 'name',
                message: 'What should this CARS server name this project:',
                default: 'Unnamed Project',
                validate: (val: string) => val.trim() ? true : 'Project name is required.'
            }
        ]);

        // Create new project
        let result: any;
        try {
            result = await client.fetch(`${cloudUrl}/api/v1/project/create`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json'
                },
                body: JSON.stringify({ name, network })
            });
            result = await result.json()
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
        { name: 'Babbage (cars.babbage.systems)', value: 'https://cars.babbage.systems' },
        { name: 'ATX (cars.atx.systems)', value: 'https://cars.atx.systems' },
        { name: 'Enter Custom URL', value: 'custom' },
        { name: 'Local (dev) localhost:7777', value: 'http://localhost:7777' },
    ];

    const { name, cloudUrlChoice, customCloudUrl, network, deployTargets } = await inquirer.prompt([
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
        }
    ]);

    let frontendHostingMethod: string | undefined = undefined;
    if (deployTargets.includes('frontend')) {
        const { frontendHosting } = await inquirer.prompt([
            {
                type: 'list',
                name: 'frontendHosting',
                message: 'Frontend hosting method (HTTPS/UHRP/none):',
                choices: ['HTTPS', 'UHRP', 'none'],
                default: 'HTTPS'
            }
        ]);
        frontendHostingMethod = frontendHosting === 'none' ? undefined : frontendHosting;
    }

    const finalCloudUrl = cloudUrlChoice === 'custom' ? customCloudUrl : cloudUrlChoice;
    const projectID = await chooseOrCreateProjectID(finalCloudUrl, undefined, network);

    const newCfg: CARSConfig = {
        name,
        provider: 'CARS',
        CARSCloudURL: finalCloudUrl,
        projectID: projectID,
        network: network.trim(),
        deploy: deployTargets,
        frontendHostingMethod
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

    const { name, cloudUrlChoice, customCloudUrl, network, deployTargets } = await inquirer.prompt([
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
        }
    ]);

    let frontendHostingMethod: string | undefined = undefined;
    if (deployTargets.includes('frontend')) {
        const { frontendHosting } = await inquirer.prompt([
            {
                type: 'list',
                name: 'frontendHosting',
                message: 'Frontend hosting method:',
                choices: ['HTTPS', 'UHRP', 'none'],
                default: config.frontendHostingMethod || 'none'
            }
        ]);
        frontendHostingMethod = frontendHosting === 'none' ? undefined : frontendHosting;
    }

    const finalCloudUrl = cloudUrlChoice === 'custom' ? customCloudUrl : cloudUrlChoice;
    const projectID = await chooseOrCreateProjectID(finalCloudUrl, config.projectID, config.network);

    config.name = name.trim();
    config.CARSCloudURL = finalCloudUrl;
    config.projectID = projectID;
    config.network = network.trim();
    config.deploy = deployTargets;
    config.frontendHostingMethod = frontendHostingMethod;

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
async function buildArtifact(nameOrIndex?: string) {
    const carsConfigInfo = loadCARSConfigInfo();
    if (carsConfigInfo.schema !== 'bsv-app') {
        console.error(chalk.red('❌ Invalid schema in deployment-info.json'));
        process.exit(1);
    }

    // Pick a CARS config to determine what to build
    const activeConfig = await pickCARSConfig(carsConfigInfo, nameOrIndex);
    const deploy = activeConfig.deploy || [];

    console.log(chalk.blue('🛠  Building local project artifact...'));
    spawnSync('npm', ['i'], { stdio: 'inherit' });

    // Backend build
    if (deploy.includes('backend')) {
        if (fs.existsSync('backend/package.json')) {
            // Check contracts language if set
            if (carsConfigInfo.contracts && carsConfigInfo.contracts.language) {
                if (carsConfigInfo.contracts.language !== 'sCrypt') {
                    console.error(chalk.red(`❌ Unsupported contracts language: ${carsConfigInfo.contracts.language}. Only 'sCrypt' is supported.`));
                    process.exit(1);
                }
                // Language is sCrypt, run compile if script exists
                spawnSync('npm', ['i'], { cwd: 'backend', stdio: 'inherit' });

                // Check if compile script exists in backend/package.json
                const backendPkg = JSON.parse(fs.readFileSync('backend/package.json', 'utf-8'));
                if (!backendPkg.scripts || !backendPkg.scripts.compile) {
                    console.error(chalk.red('❌ No "compile" script found in backend package.json for sCrypt contracts.'));
                    process.exit(1);
                }
                const compileResult = spawnSync('npm', ['run', 'compile'], { cwd: 'backend', stdio: 'inherit' });
                if (compileResult.status !== 0) {
                    console.error(chalk.red('❌ sCrypt contract compilation failed.'));
                    process.exit(1);
                }
                const buildResult = spawnSync('npm', ['run', 'build'], { cwd: 'backend', stdio: 'inherit' });
                if (buildResult.status !== 0) {
                    console.error(chalk.red('❌ Backend build failed.'));
                    process.exit(1);
                }
            } else {
                spawnSync('npm', ['i'], { cwd: 'backend', stdio: 'inherit' });
                const backendPkg = JSON.parse(fs.readFileSync('backend/package.json', 'utf-8'));
                if (backendPkg.scripts && backendPkg.scripts.build) {
                    const buildResult = spawnSync('npm', ['run', 'build'], { cwd: 'backend', stdio: 'inherit' });
                    if (buildResult.status !== 0) {
                        console.error(chalk.red('❌ Backend build failed.'));
                        process.exit(1);
                    }
                }
            }
        } else {
            console.error(chalk.red('❌ Backend specified in deploy but no backend/package.json found.'));
            process.exit(1);
        }
    }

    // Frontend build
    if (deploy.includes('frontend')) {
        if (!carsConfigInfo.frontend || !carsConfigInfo.frontend.language) {
            console.error(chalk.red('❌ Frontend is included in deploy but no frontend configuration (language) found.'));
            process.exit(1);
        }
        const frontendLang = carsConfigInfo.frontend.language.toLowerCase();
        if (!fs.existsSync('frontend/package.json')) {
            if (frontendLang === 'html') {
                // If html, we just need index.html
                if (!fs.existsSync('frontend/index.html')) {
                    console.error(chalk.red('❌ Frontend language set to html but no index.html found in frontend directory.'));
                    process.exit(1);
                }
            } else {
                console.error(chalk.red('❌ Frontend language requires a build but no frontend/package.json found.'));
                process.exit(1);
            }
        }

        if (frontendLang === 'react') {
            // React build
            spawnSync('npm', ['i'], { cwd: 'frontend', stdio: 'inherit' });
            const buildResult = spawnSync('npm', ['run', 'build'], { cwd: 'frontend', stdio: 'inherit' });
            if (buildResult.status !== 0) {
                console.error(chalk.red('❌ Frontend build (react) failed.'));
                process.exit(1);
            }
            if (!fs.existsSync('frontend/build')) {
                console.error(chalk.red('❌ React build directory not found in frontend/build after build.'));
                process.exit(1);
            }
        } else if (frontendLang === 'html') {
            // Just check index.html
            if (!fs.existsSync('frontend/index.html')) {
                console.error(chalk.red('❌ Frontend language set to html but no index.html found.'));
                process.exit(1);
            }
        } else {
            console.error(chalk.red(`❌ Unsupported frontend language: ${carsConfigInfo.frontend.language}. Only 'react' or 'html' are currently supported. CARS pull requests are welcome!`));
            process.exit(1);
        }
    }

    const artifactName = `${ARTIFACT_PREFIX}${Date.now()}${ARTIFACT_EXTENSION}`;

    // We'll create a temporary directory to stage files
    const tmpDir = path.join(process.cwd(), 'cars_tmp_build_' + Date.now());
    fs.mkdirSync(tmpDir);

    // Always include deployment-info.json, package.json, package-lock.json if they exist
    copyIfExists('deployment-info.json', tmpDir);
    copyIfExists('package.json', tmpDir);
    copyIfExists('package-lock.json', tmpDir);

    if (deploy.includes('backend')) {
        if (!fs.existsSync('backend')) {
            console.error(chalk.red('❌ Backend deploy requested but no backend directory found.'));
            process.exit(1);
        }
        copyDirectory('backend', path.join(tmpDir, 'backend'));
    }

    if (deploy.includes('frontend')) {
        const frontendLang = carsConfigInfo.frontend?.language.toLowerCase();
        if (frontendLang === 'react') {
            // Copy frontend/build to frontend
            if (!fs.existsSync('frontend/build')) {
                console.error(chalk.red('❌ React frontend build output not found.'));
                process.exit(1);
            }
            copyDirectory('frontend/build', path.join(tmpDir, 'frontend'));
        } else if (frontendLang === 'html') {
            // Copy entire frontend directory as is
            if (!fs.existsSync('frontend/index.html')) {
                console.error(chalk.red('❌ HTML frontend index.html not found.'));
                process.exit(1);
            }
            copyDirectory('frontend', path.join(tmpDir, 'frontend'));
        }
    }

    await tar.create({ gzip: true, file: artifactName, cwd: tmpDir }, ['.']);
    fs.rmSync(tmpDir, { recursive: true, force: true });

    console.log(chalk.green(`✅ Artifact created: ${artifactName}`));
    return artifactName;
}

function copyIfExists(src: string, destDir: string) {
    if (fs.existsSync(src)) {
        const dest = path.join(destDir, path.basename(src));
        fs.copyFileSync(src, dest);
    }
}

function copyDirectory(src: string, dest: string) {
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirectory(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
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
 * Helper for requests
 */

async function safeRequest<T = any>(client: AuthFetch, baseUrl: string, endpoint: string, data: any): Promise<T | undefined> {
    try {
        const response = await client.fetch(`${baseUrl}${endpoint}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify(data)
        });
        return await response.json()
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
 * Data formatting
 */
function printProjectList(projects: ProjectListing[]) {
    if (!projects || projects.length === 0) {
        console.log(chalk.yellow('No projects found.'));
        return;
    }
    const table = new Table({ head: ['Project ID', 'Name', 'Balance', 'Created'] });
    projects.forEach(p => table.push([p.id, p.name, p.balance, new Date(p.created_at).toLocaleString()]));
    console.log(table.toString());
}

function printAdminsList(admins: AdminInfo[]) {
    if (!admins || admins.length === 0) {
        console.log(chalk.yellow('No admins found.'));
        return;
    }
    const table = new Table({ head: ['Identity Key', 'Email', 'Added At'] });
    admins.forEach(a => table.push([a.identity_key, a.email, new Date(a.added_at).toLocaleString()]));
    console.log(table.toString());
}

function printLogs(log: string, title: string) {
    console.log(chalk.blue(`${title}:`));
    console.log(log.trim() || chalk.yellow('No logs yet.'));
}

function printReleasesList(deploys: DeployInfo[]) {
    if (!deploys || deploys.length === 0) {
        console.log(chalk.yellow('No releases found.'));
        return;
    }
    const table = new Table({ head: ['Release ID', 'Created At'] });
    deploys.forEach(d => table.push([d.deployment_uuid, new Date(d.created_at).toLocaleString()]));
    console.log(table.toString());
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

async function buildAuthFetch(config: CARSConfig) {
    if (!config.CARSCloudURL) {
        console.error(chalk.red('❌ CARSCloudURL not set on this configuration.'));
        process.exit(1);
    }
    await ensureRegistered(config);
    return new AuthFetch(new WalletClient('auto', 'localhost'));
}

/**
 * helper to pick a release ID from a list if not provided
 */
async function pickReleaseId(config: CARSConfig, providedReleaseId?: string): Promise<string | undefined> {
    if (providedReleaseId) {
        return providedReleaseId;
    }
    const client = await buildAuthFetch(config);
    const result = await safeRequest<{ deploys: DeployInfo[] }>(client, config.CARSCloudURL, `/api/v1/project/${config.projectID}/deploys/list`, {});
    if (!result || !Array.isArray(result.deploys) || result.deploys.length === 0) {
        console.log(chalk.yellow('No releases found. Cannot select a release ID.'));
        return undefined;
    }

    const { chosenRelease } = await inquirer.prompt([
        {
            type: 'list',
            name: 'chosenRelease',
            message: 'Select a release ID:',
            choices: result.deploys.map(d => ({
                name: `${d.deployment_uuid} (Created: ${new Date(d.created_at).toLocaleString()})`,
                value: d.deployment_uuid
            }))
        }
    ]);

    return chosenRelease;
}

/**
 * LOGGING PROMPTS
 */

async function promptResourceLogParameters(): Promise<{ resource: string; since: LogPeriod; tail: number; level: LogLevel }> {
    const { resource } = await inquirer.prompt([
        {
            type: 'list',
            name: 'resource',
            message: 'Select resource to view logs from:',
            choices: ['frontend', 'backend', 'mongo', 'mysql']
        }
    ]);

    const { since } = await inquirer.prompt([
        {
            type: 'list',
            name: 'since',
            message: 'Select time period:',
            choices: VALID_LOG_PERIODS,
            default: '1h'
        }
    ]);

    const { tail } = await inquirer.prompt([
        {
            type: 'number',
            name: 'tail',
            message: 'Number of lines to tail (1-10000):',
            default: 1000,
            validate: (val: number) => val > 0 && val <= MAX_TAIL_LINES ? true : 'Invalid tail number'
        }
    ]);

    const { level } = await inquirer.prompt([
        {
            type: 'list',
            name: 'level',
            message: 'Select log level filter:',
            choices: VALID_LOG_LEVELS,
            default: 'all'
        }
    ]);

    return { resource, since: since as LogPeriod, tail, level: level as LogLevel };
}

async function fetchResourceLogs(config: CARSConfig, params?: { resource?: string; since?: string; tail?: number; level?: string }) {
    if (!config.projectID) {
        console.error(chalk.red('❌ No project ID in configuration.'));
        return;
    }

    const finalParams = { ...params };
    if (!finalParams.resource || !['frontend', 'backend', 'mongo', 'mysql'].includes(finalParams.resource)) {
        const userParams = await promptResourceLogParameters();
        Object.assign(finalParams, userParams);
    }

    if (!isValidLogPeriod(finalParams.since || '1h')) {
        finalParams.since = '1h';
    }
    if (!isValidLogLevel(finalParams.level || 'all')) {
        finalParams.level = 'all';
    }
    const tailVal = Math.min(Math.max(1, Math.floor(finalParams.tail || 1000)), MAX_TAIL_LINES);

    const client = await buildAuthFetch(config);
    const result = await safeRequest<{ logs: string; metadata: any }>(
        client,
        config.CARSCloudURL,
        `/api/v1/project/${config.projectID}/logs/resource/${finalParams.resource}`,
        { since: finalParams.since, tail: tailVal, level: finalParams.level }
    );

    if (result && typeof result.logs === 'string') {
        printLogs(result.logs, `Resource ${finalParams.resource} Logs`);
    }
}

/**
 * Domain Linking (Custom Domains)
 */

// Print instructions
function printDomainInstrictions(projectID: string, domain: string, domainType: 'frontend' | 'backend') {
    console.log(chalk.blue('\nCustom Domain DNS Validation Instructions:'))
    console.log(`Please create a DNS TXT record at:   cars_project.${domain}`)
    console.log(`With the exact value (no quotes):    "cars-project-verification=${projectID}:${domainType}"`)
    console.log('Once this TXT record is in place, continue with validation.\n');
}

// Set a custom domain for frontend or backend.
// If validation fails, instructions are returned. For interactive mode, prompt user to try again after fixing DNS.
async function setCustomDomain(config: CARSConfig, domainType: 'frontend' | 'backend', domain: string, interactive: boolean) {
    if (!config.projectID) {
        console.error(chalk.red('❌ No project ID set in this configuration.'));
        return;
    }

    const client = await buildAuthFetch(config);

    if (interactive) {
        printDomainInstrictions(config.projectID, domain, domainType)

        // Make sure they're ready to start the process
        const { confirm } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'confirm',
                message: `Ready to proceed?`,
                default: true
            }
        ]);

        if (!confirm) {
            return;
        }
    }

    let retry = true;
    while (retry) {
        try {
            let result: any = await client.fetch(`${config.CARSCloudURL}/api/v1/project/${config.projectID}/domains/${domainType}`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json'
                },
                body: JSON.stringify({ domain })
            });
            result = await result.json()
            if (result && result.domain) {
                console.log(chalk.green(`✅ ${domainType.charAt(0).toUpperCase() + domainType.slice(1)} custom domain set successfully.`));
                return;
            } else {
                throw new Error('No domain in response.');
            }
        } catch (error: any) {
            if (!interactive) {
                handleRequestError(error, 'Domain verification failed');
                return;
            }
            printDomainInstrictions(config.projectID, domain, domainType)

            // Ask user if they want to try again after DNS is set
            const { confirm } = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'confirm',
                    message: `DNS not verified yet, allow some time to propagate. Try again now?`,
                    default: false
                }
            ]);

            if (!confirm) {
                retry = false;
            }
        }
    }
}

/**
 * Web UI Config Management
 */

async function viewAndEditWebUIConfig(config: CARSConfig) {
    if (!config.projectID) {
        console.error(chalk.red('❌ No project ID set.'));
        return;
    }

    const client = await buildAuthFetch(config);

    // Fetch current info
    const info = await safeRequest<ProjectInfo>(client, config.CARSCloudURL, `/api/v1/project/${config.projectID}/info`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json'
        },
        body: '{}'
    });
    if (!info) return;

    let webUIConfig = info.webUIConfig || {};

    // Interactive edit loop
    let done = false;
    while (!done) {
        console.log(chalk.blue(`\nCurrent Web UI Config:`));
        const table = new Table({ head: ['Key', 'Value'] });
        Object.keys(webUIConfig).forEach(k => table.push([k, JSON.stringify(webUIConfig[k])]));
        console.log(table.toString());

        const choices = [
            { name: 'Add/Update a key', value: 'update' },
            { name: 'Remove a key', value: 'remove' },
            { name: 'Done', value: 'done' }
        ];

        const { action } = await inquirer.prompt([
            { type: 'list', name: 'action', message: 'What do you want to do?', choices }
        ]);

        if (action === 'done') {
            done = true;
        } else if (action === 'update') {
            const { key } = await inquirer.prompt([
                { type: 'input', name: 'key', message: 'Enter the key:' }
            ]);
            const { val } = await inquirer.prompt([
                { type: 'input', name: 'val', message: 'Enter the value (JSON, string, number, etc.):' }
            ]);
            let parsedVal: any = val;
            try {
                parsedVal = JSON.parse(val);
            } catch (ignore) {
                // If not JSON, just use string
            }
            webUIConfig[key] = parsedVal;
        } else if (action === 'remove') {
            const keys = Object.keys(webUIConfig);
            if (keys.length === 0) {
                console.log(chalk.yellow('No keys to remove.'));
                continue;
            }
            const { keyToRemove } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'keyToRemove',
                    message: 'Select a key to remove:',
                    choices: keys
                }
            ]);
            delete webUIConfig[keyToRemove];
        }

        if (action !== 'done') {
            // Update on server
            const resp = await safeRequest(client, config.CARSCloudURL, `/api/v1/project/${config.projectID}/webui/config`, { config: webUIConfig });
            if (resp) {
                console.log(chalk.green('✅ Web UI config updated.'));
            }
        }
    }
}

/**
 * Billing Stats
 */
async function viewBillingStats(config: CARSConfig) {
    const client = await buildAuthFetch(config);

    // Let user pick filters
    const { start } = await inquirer.prompt([
        { type: 'input', name: 'start', message: 'Start time (YYYY-MM-DD or empty for none):', default: '' }
    ]);
    const { end } = await inquirer.prompt([
        { type: 'input', name: 'end', message: 'End time (YYYY-MM-DD or empty for none):', default: '' }
    ]);
    const { type } = await inquirer.prompt([
        { type: 'list', name: 'type', message: 'Type of records to show:', choices: ['all', 'debit', 'credit'], default: 'all' }
    ]);

    const data: any = {};
    if (start.trim()) data.start = new Date(start.trim()).toISOString();
    if (end.trim()) data.end = new Date(end.trim()).toISOString();
    if (type !== 'all') data.type = type;

    const records = await safeRequest<{ records: AccountingRecord[] }>(client, config.CARSCloudURL, `/api/v1/project/${config.projectID}/billing/stats`, data);
    if (!records) return;

    if (records.records.length === 0) {
        console.log(chalk.yellow('No billing records found for specified filters.'));
        return;
    }

    const table = new Table({ head: ['Timestamp', 'Type', 'Amount (sats)', 'Balance After', 'Metadata'] });
    records.records.forEach(r => {
        table.push([new Date(r.timestamp).toLocaleString(), r.type, r.amount_sats, r.balance_after, JSON.stringify(r.metadata, null, 2)]);
    });
    console.log(table.toString());
}

/**
 * Project Info and Balance Checking
 */
async function showProjectInfo(config: CARSConfig) {
    if (!config.projectID) {
        console.error(chalk.red('❌ No project ID set.'));
        return;
    }
    const client = await buildAuthFetch(config);
    const info = await safeRequest<ProjectInfo>(client, config.CARSCloudURL, `/api/v1/project/${config.projectID}/info`, {});
    if (!info) return;

    console.log(chalk.magentaBright(`\nProject "${info.name}" (ID: ${info.id}) Info:`));
    const table = new Table();
    table.push(['Network', info.network]);
    table.push(['Balance', info.billing.balance.toString()]);
    table.push(['Online', info.status.online ? 'Yes' : 'No']);
    table.push(['Last Checked', new Date(info.status.lastChecked).toLocaleString()]);
    table.push(['Current Deployment', info.status.deploymentId || 'None']);
    table.push(['SSL Enabled', info.sslEnabled ? 'Yes' : 'No']);
    table.push(['Frontend Domain', info.status.domains.frontend || info.customDomains.frontend || 'None']);
    table.push(['Backend Domain', info.status.domains.backend || info.customDomains.backend || 'None']);
    console.log(table.toString());

    if (info.webUIConfig) {
        console.log(chalk.blue('\nWeb UI Config:'));
        const wtable = new Table({ head: ['Key', 'Value'] });
        Object.keys(info.webUIConfig).forEach(k => wtable.push([k, JSON.stringify(info.webUIConfig[k])]));
        console.log(wtable.toString());
    }

    // Prompt to top up if balance is low
    if (info.billing.balance < 50000) {
        console.log(chalk.yellow('⚠ Your balance is low. Consider topping up to prevent disruptions.'));
        const { confirm } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'confirm',
                message: 'Do you want to add funds now?',
                default: true
            }
        ]);
        if (confirm) {
            await topUpProjectBalance(config);
        }
    }
}

/**
 * Top up Project Balance
 */
async function topUpProjectBalance(config: CARSConfig) {
    if (!config.projectID) {
        console.error(chalk.red('❌ No project ID set.'));
        return;
    }
    const { amount } = await inquirer.prompt([
        { type: 'number', name: 'amount', message: 'Enter amount in satoshis to add:', validate: (val: number) => val > 0 ? true : 'Amount must be positive.' }
    ]);

    const client = await buildAuthFetch(config);
    const result = await safeRequest(client, config.CARSCloudURL, `/api/v1/project/${config.projectID}/pay`, { amount });
    if (result) {
        console.log(chalk.green(`✅ Balance topped up by ${amount} sats.`));
    }
}

/**
 * Delete Project
 */
async function deleteProject(config: CARSConfig) {
    if (!config.projectID) {
        console.error(chalk.red('❌ No project ID set.'));
        return;
    }
    const { confirm } = await inquirer.prompt([
        { type: 'confirm', name: 'confirm', message: 'Are you ABSOLUTELY CERTAIN that you want to delete this project (this cannot be undone)?', default: false }
    ]);
    if (!confirm) return;

    const { confirmAgain } = await inquirer.prompt([
        { type: 'confirm', name: 'confirmAgain', message: 'Really delete the entire project and all its data permanently?', default: false }
    ]);
    if (!confirmAgain) return;

    const client = await buildAuthFetch(config);
    const result = await safeRequest(client, config.CARSCloudURL, `/api/v1/project/${config.projectID}/delete`, {});
    if (result) {
        console.log(chalk.green('✅ Project deleted.'));
    }
}

/**
 * Global Public Info
 */
async function showGlobalPublicInfo() {
    const info = loadCARSConfigInfo();
    const chosenURL = await chooseCARSCloudURL(info);
    const spinner = ora('Fetching global public info...').start();
    try {
        const res = await axios.get(`${chosenURL}/api/v1/public`);
        spinner.succeed('✅ Fetched global info:');
        const data = res.data;
        console.log(chalk.blue('Mainnet Public Key:'), data.mainnetPublicKey);
        console.log(chalk.blue('Testnet Public Key:'), data.testnetPublicKey);
        console.log(chalk.blue('Pricing:'));
        const table = new Table({ head: ['Resource', 'Cost (per 5m)'] });
        table.push(['CPU (per core)', data.pricing.cpu_rate_per_5min + ' sat']);
        table.push(['Memory (per GB)', data.pricing.mem_rate_per_gb_5min + ' sat']);
        table.push(['Disk (per GB)', data.pricing.disk_rate_per_gb_5min + ' sat']);
        table.push(['Network (per GB)', data.pricing.net_rate_per_gb_5min + ' sat']);
        console.log(table.toString());
        console.log(chalk.blue('Project Deployment Domain:'), data.projectDeploymentDomain);
    } catch (error: any) {
        spinner.fail('❌ Failed to fetch public info.');
        handleRequestError(error);
    }
}

// Interactive editing for advanced engine config
async function editAdvancedEngineConfig(config: CARSConfig) {
    if (!config.projectID) {
        console.error(chalk.red('❌ No project ID set.'));
        return;
    }
    const client = await buildAuthFetch(config);

    // We fetch the current engine config from the project info
    const infoResp = await safeRequest<any>(client, config.CARSCloudURL, `/api/v1/project/${config.projectID}/info`, {});
    if (!infoResp) return;
    let engineConfig: any = {};
    if (infoResp.engine_config) {
        engineConfig = infoResp.engine_config;
    } else {
        engineConfig = {};
    }
    if (!engineConfig || typeof engineConfig !== 'object') {
        engineConfig = {};
    }

    let done = false;
    while (!done) {
        console.log(chalk.blue('\nCurrent Engine Config:'));
        console.log(JSON.stringify(engineConfig, null, 2));

        const choices = [
            { name: 'Toggle requestLogging', value: 'requestLogging' },
            { name: 'Toggle gaspSync', value: 'gaspSync' },
            { name: 'Toggle logTime', value: 'logTime' },
            { name: 'Set logPrefix', value: 'logPrefix' },
            { name: 'Toggle throwOnBroadcastFailure', value: 'throwFail' },
            { name: 'Edit syncConfiguration', value: 'syncConfig' },
            { name: 'Done', value: 'done' }
        ];

        const { action } = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: 'Select an advanced config to edit:',
                choices
            }
        ]);

        if (action === 'done') {
            done = true;
        } else if (action === 'requestLogging') {
            engineConfig.requestLogging = !engineConfig.requestLogging;
        } else if (action === 'gaspSync') {
            engineConfig.gaspSync = !engineConfig.gaspSync;
        } else if (action === 'logTime') {
            engineConfig.logTime = !engineConfig.logTime;
        } else if (action === 'logPrefix') {
            const { prefix } = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'prefix',
                    message: 'Enter new log prefix:',
                    default: engineConfig.logPrefix || '[CARS OVERLAY ENGINE] '
                }
            ]);
            engineConfig.logPrefix = prefix;
        } else if (action === 'throwFail') {
            engineConfig.throwOnBroadcastFailure = !engineConfig.throwOnBroadcastFailure;
        } else if (action === 'syncConfig') {
            await editSyncConfiguration(engineConfig);
        }

        // Immediately push updates to the server
        const updateResult = await safeRequest(
            client,
            config.CARSCloudURL,
            `/api/v1/project/${config.projectID}/settings/update`,
            { ...engineConfig } // we flatten them in request
        );
        if (updateResult && updateResult.engineConfig) {
            // Re-assign to keep in sync with server response if needed
            engineConfig = updateResult.engineConfig;
            console.log(chalk.green('✅ Engine settings updated successfully.'));
        } else {
            console.log(chalk.yellow('No update response or partial update.'));
        }
    }
}

// Helper to interactively edit syncConfiguration
async function editSyncConfiguration(engineConfig: any) {
    engineConfig.syncConfiguration = engineConfig.syncConfiguration || {};
    let done = false;
    while (!done) {
        console.log(chalk.blue('\nSync Configuration Menu'));
        const existingTopics = Object.keys(engineConfig.syncConfiguration);
        const topicChoices = existingTopics.map(t => {
            const val = engineConfig.syncConfiguration[t];
            let valDesc = '';
            if (val === false) valDesc = 'false';
            else if (val === 'SHIP') valDesc = 'SHIP';
            else if (Array.isArray(val)) valDesc = JSON.stringify(val);
            else valDesc = `${val}`;
            return { name: `${t}: ${valDesc}`, value: t };
        });
        topicChoices.push({ name: 'Add new topic', value: 'addNewTopic' });
        topicChoices.push({ name: 'Back', value: 'back' });

        const { selectedTopic } = await inquirer.prompt([
            {
                type: 'list',
                name: 'selectedTopic',
                message: 'Select a topic to edit or add new:',
                choices: topicChoices
            }
        ]);

        if (selectedTopic === 'back') {
            done = true;
        } else if (selectedTopic === 'addNewTopic') {
            const { newTopic } = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'newTopic',
                    message: 'Enter the new topic name:'
                }
            ]);
            engineConfig.syncConfiguration[newTopic.trim()] = 'SHIP';
        } else {
            // Toggle or set
            const topicVal = engineConfig.syncConfiguration[selectedTopic];
            const { action } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'action',
                    message: `Editing "${selectedTopic}" (current: ${JSON.stringify(topicVal)}). Choose an action:`,
                    choices: [
                        { name: 'Set to false (no sync)', value: 'false' },
                        { name: 'Set to SHIP (global discovery)', value: 'SHIP' },
                        { name: 'Set to array of custom endpoints', value: 'array' },
                        { name: 'Remove topic from the config', value: 'remove' },
                        { name: 'Cancel', value: 'cancel' }
                    ]
                }
            ]);

            if (action === 'remove') {
                delete engineConfig.syncConfiguration[selectedTopic];
            } else if (action === 'false') {
                engineConfig.syncConfiguration[selectedTopic] = false;
            } else if (action === 'SHIP') {
                engineConfig.syncConfiguration[selectedTopic] = 'SHIP';
            } else if (action === 'array') {
                const { endpoints } = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'endpoints',
                        message:
                            'Enter comma-separated endpoints (e.g. https://peer1,https://peer2):'
                    }
                ]);
                const splitted = endpoints
                    .split(',')
                    .map((e: string) => e.trim())
                    .filter((x: string) => !!x);
                engineConfig.syncConfiguration[selectedTopic] = splitted;
            }
        }
    }
}

// Trigger the admin-protected endpoints via /admin/syncAdvertisements or /admin/startGASPSync
async function triggerAdminEndpoint(config: CARSConfig, endpoint: 'syncAdvertisements' | 'startGASPSync') {
    if (!config.projectID) {
        console.error(chalk.red('❌ No project ID set.'));
        return;
    }
    const client = await buildAuthFetch(config);
    const route = endpoint === 'syncAdvertisements'
        ? `/api/v1/project/${config.projectID}/admin/syncAdvertisements`
        : `/api/v1/project/${config.projectID}/admin/startGASPSync`;
    const spinner = ora(`Triggering admin endpoint: ${endpoint}...`).start();
    try {
        let resp = await client.fetch(`${config.CARSCloudURL}${route}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: '{}'
        });
        resp = await resp.json()
        spinner.succeed(`✅ ${endpoint} responded: ${JSON.stringify(resp)}`);
    } catch (error: any) {
        spinner.fail(`❌ ${endpoint} failed.`);
        handleRequestError(error);
    }
}

/**
 * Menus
 */
async function mainMenu() {
    console.log(chalk.cyanBright(`\nWelcome to CARS CLI ⚡`));
    console.log(chalk.cyan(`Your Deployment Companion for Bitcoin-Powered Clouds\n`));

    const info = loadCARSConfigInfo();
    const choices = [
        { name: 'Manage CARS Configurations', value: 'config' },
        { name: 'Manage Projects', value: 'project' },
        { name: 'Manage Releases', value: 'release' },
        { name: 'Manage Artifacts', value: 'artifact' },
        { name: 'View Global Info (Public Keys, Pricing)', value: 'global-info' },
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
        } else if (action === 'global-info') {
            await showGlobalPublicInfo();
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
        { name: 'View Project Info', value: 'info' },
        { name: 'Add Admin', value: 'add-admin' },
        { name: 'Remove Admin', value: 'remove-admin' },
        { name: 'List Admins', value: 'list-admins' },
        { name: 'View Project Logs', value: 'logs-project' },
        { name: 'View Resource (Runtime) Logs', value: 'logs-resource' },
        { name: 'List Releases', value: 'releases' },
        { name: 'Set Frontend Custom Domain', value: 'domain-frontend' },
        { name: 'Set Backend Custom Domain', value: 'domain-backend' },
        { name: 'View/Edit Web UI Config', value: 'webui-config' },
        { name: 'Billing: View Stats', value: 'billing-stats' },
        { name: 'Billing: Top Up Balance', value: 'topup' },
        { name: 'Delete Project', value: 'delete' },
        { name: 'Edit Advanced Engine Config', value: 'edit-engine-config' },
        { name: 'Trigger admin syncAdvertisements', value: 'admin-sync-ads' },
        { name: 'Trigger admin startGASPSync', value: 'admin-start-gasp' },
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
            const client = new AuthFetch(new WalletClient('auto', 'localhost'));
            await ensureRegistered({ provider: 'CARS', CARSCloudURL: chosenURL, name: 'CARS' });
            let result: { projects: ProjectListing[] };
            try {
                const res = await client.fetch(`${chosenURL}/api/v1/project/list`, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json'
                    },
                    body: '{}'
                });
                result = await res.json()
                printProjectList(result.projects);
            } catch (e: any) {
                handleRequestError(e, 'Failed to list projects');
            }
        } else if (action === 'info') {
            const config = await pickCARSConfig(info);
            await showProjectInfo(config);
        } else if (action === 'add-admin') {
            const config = await pickCARSConfig(info);
            if (!config.projectID) { console.error(chalk.red('❌ No project ID.')); continue; }
            const client = await buildAuthFetch(config);
            console.log(chalk.yellow('Please enter Identity Key or Email of the user to add as admin:'));
            const { identityKeyOrEmail } = await inquirer.prompt([
                { type: 'input', name: 'identityKeyOrEmail', message: 'IdentityKey or Email:' }
            ]);
            const result = await safeRequest(client, config.CARSCloudURL, `/api/v1/project/${config.projectID}/addAdmin`, { identityKeyOrEmail });
            if (result.message) {
                console.log(chalk.green(`✅ ${result.message}`));
            } else {
                console.error(chalk.red(`❌ ${result.error || 'Could not add project admin.'}`));
            }
        } else if (action === 'remove-admin') {
            const config = await pickCARSConfig(info);
            if (!config.projectID) { console.error(chalk.red('❌ No project ID.')); continue; }
            const client = await buildAuthFetch(config);
            const result = await safeRequest<{ admins: AdminInfo[] }>(client, config.CARSCloudURL, `/api/v1/project/${config.projectID}/admins/list`, {});
            if (result) {
                if (result.admins.length === 0) {
                    console.log(chalk.yellow('No admins found.'));
                    continue;
                }
                const { chosenAdmin } = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'chosenAdmin',
                        message: 'Select admin to remove:',
                        choices: result.admins.map(a => ({
                            name: `${a.identity_key} (${a.email}) added at ${new Date(a.added_at).toLocaleString()}`,
                            value: a.identity_key
                        }))
                    }
                ]);
                const rmResult = await safeRequest(client, config.CARSCloudURL, `/api/v1/project/${config.projectID}/removeAdmin`, { identityKeyOrEmail: chosenAdmin });
                if (rmResult.message) {
                    console.log(chalk.green(`✅ ${rmResult.message}`));
                } else {
                    console.error(chalk.red(`❌ ${rmResult.error || 'Could not remove project admin.'}`));
                }
            }
        } else if (action === 'list-admins') {
            const config = await pickCARSConfig(info);
            if (!config.projectID) { console.error(chalk.red('❌ No project ID.')); continue; }
            const client = await buildAuthFetch(config);
            const result = await safeRequest<{ admins: AdminInfo[] }>(client, config.CARSCloudURL, `/api/v1/project/${config.projectID}/admins/list`, {});
            if (result && result.admins) {
                printAdminsList(result.admins);
            }
        } else if (action === 'logs-project') {
            const config = await pickCARSConfig(info);
            if (!config.projectID) { console.error(chalk.red('❌ No project ID.')); continue; }
            const client = await buildAuthFetch(config);
            const result = await safeRequest<{ logs: string }>(client, config.CARSCloudURL, `/api/v1/project/${config.projectID}/logs/project`, {});
            if (result && typeof result.logs === 'string') {
                printLogs(result.logs, 'Project Logs');
            }
        } else if (action === 'logs-resource') {
            const config = await pickCARSConfig(info);
            await fetchResourceLogs(config);
        } else if (action === 'releases') {
            const config = await pickCARSConfig(info);
            if (!config.projectID) { console.error(chalk.red('❌ No project ID.')); continue; }
            const client = await buildAuthFetch(config);
            const result = await safeRequest<{ deploys: DeployInfo[] }>(client, config.CARSCloudURL, `/api/v1/project/${config.projectID}/deploys/list`, {});
            if (result && Array.isArray(result.deploys)) {
                printReleasesList(result.deploys);
            }
        } else if (action === 'domain-frontend') {
            const config = await pickCARSConfig(info);
            const { domain } = await inquirer.prompt([
                { type: 'input', name: 'domain', message: 'Enter the frontend domain (e.g. example.com):' }
            ]);
            await setCustomDomain(config, 'frontend', domain, true);
        } else if (action === 'domain-backend') {
            const config = await pickCARSConfig(info);
            const { domain } = await inquirer.prompt([
                { type: 'input', name: 'domain', message: 'Enter the backend domain (e.g. backend.example.com):' }
            ]);
            await setCustomDomain(config, 'backend', domain, true);
        } else if (action === 'webui-config') {
            const config = await pickCARSConfig(info);
            await viewAndEditWebUIConfig(config);
        } else if (action === 'billing-stats') {
            const config = await pickCARSConfig(info);
            await viewBillingStats(config);
        } else if (action === 'topup') {
            const config = await pickCARSConfig(info);
            await topUpProjectBalance(config);
        } else if (action === 'delete') {
            const config = await pickCARSConfig(info);
            await deleteProject(config);
        } else if (action === 'edit-engine-config') {
            const config = await pickCARSConfig(info);
            await editAdvancedEngineConfig(config);
        } else if (action === 'admin-sync-ads') {
            const config = await pickCARSConfig(info);
            await triggerAdminEndpoint(config, 'syncAdvertisements');
        } else if (action === 'admin-start-gasp') {
            const config = await pickCARSConfig(info);
            await triggerAdminEndpoint(config, 'startGASPSync');
        } else {
            done = true;
        }
    }
}

async function releaseMenu() {
    const info = loadCARSConfigInfo();
    const choices = [
        { name: 'Auto-create new release and upload latest artifact now', value: 'now' },
        { name: 'View logs for a release', value: 'logs' },
        { name: 'Create new release for manual upload (get upload URL)', value: 'get-upload-url' },
        { name: 'Upload artifact to a manual release URL', value: 'upload-files' },
        { name: 'View deployment logs (manual input)', value: 'logs-deployment-manual' },
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
            const client = await buildAuthFetch(config);
            const result = await safeRequest<{ url: string, deploymentId: string }>(client, config.CARSCloudURL, `/api/v1/project/${config.projectID}/deploy`, {});
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
            if (!config.projectID) {
                console.error(chalk.red('❌ No project ID set in this configuration.'));
                continue;
            }
            const releaseId = await pickReleaseId(config);
            if (!releaseId) {
                continue;
            }
            const client = await buildAuthFetch(config);
            const result = await safeRequest<{ logs: string }>(client, config.CARSCloudURL, `/api/v1/project/${config.projectID}/logs/deployment/${releaseId}`, {});
            if (result && typeof result.logs === 'string') {
                printLogs(result.logs, 'Release Logs');
            }
        } else if (action === 'logs-deployment-manual') {
            // Allows entering a deploymentId manually
            const config = await pickCARSConfig(info);
            if (!config.projectID) {
                console.error(chalk.red('❌ No project ID set in this configuration.'));
                continue;
            }
            const { deploymentId } = await inquirer.prompt([
                { type: 'input', name: 'deploymentId', message: 'Enter Deployment (Release) ID:' }
            ]);
            const client = await buildAuthFetch(config);
            const result = await safeRequest<{ logs: string }>(client, config.CARSCloudURL, `/api/v1/project/${config.projectID}/logs/deployment/${deploymentId}`, {});
            if (result && typeof result.logs === 'string') {
                printLogs(result.logs, 'Release Logs');
            }
        } else if (action === 'now') {
            const config = await pickCARSConfig(info);
            if (!config.projectID) {
                console.error(chalk.red('❌ No project ID set.'));
                continue;
            }

            const artifactPath = findLatestArtifact();
            const client = await buildAuthFetch(config);
            const result = await safeRequest<{ url: string, deploymentId: string }>(client, config.CARSCloudURL, `/api/v1/project/${config.projectID}/deploy`, {});
            if (result && result.url && result.deploymentId) {
                await uploadArtifact(result.url, artifactPath);
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
 * Upload Artifact
 * 
 * @param uploadURL The URL to upload the artifact to
 * @param artifactPath The path to the artifact file
 * 
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
                'content-type': 'application/octet-stream'
            },
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

// CARS config management
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
    .description('Delete a CARS configuration')
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

configCommand.action(async () => {
    await configMenu();
});


// Build local artifact
program
    .command('build [nameOrIndex]')
    .description('Build local artifact for release')
    .action(async (nameOrIndex) => {
        await buildArtifact(nameOrIndex);
    });


// Project management
const projectCommand = program
    .command('project')
    .description('Manage projects');

// List projects
projectCommand
    .command('ls [nameOrIndex]')
    .description('List all projects on a chosen CARS Cloud server')
    .action(async (nameOrIndex) => {
        const info = loadCARSConfigInfo();
        const chosenURL = await chooseCARSCloudURL(info, nameOrIndex);
        const client = new AuthFetch(new WalletClient('auto', 'localhost'));
        await ensureRegistered({ provider: 'CARS', CARSCloudURL: chosenURL, name: 'CARS' });
        try {
            const result = await client.fetch(`${chosenURL}/api/v1/project/list`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json'
                },
                body: '{}'
            });
            const resultJson = await result.json()
            printProjectList(resultJson.projects);
        } catch (e: any) {
            handleRequestError(e, 'Failed to list projects');
        }
    });

// Show project info
projectCommand
    .command('info [nameOrIndex]')
    .description('Show detailed info about the project in the chosen configuration')
    .action(async (nameOrIndex) => {
        const info = loadCARSConfigInfo();
        const cfg = await pickCARSConfig(info, nameOrIndex);
        await showProjectInfo(cfg);
    });

// Add admin
projectCommand
    .command('add-admin <identityKeyOrEmail> [nameOrIndex]')
    .description('Add an admin to the project of the chosen configuration')
    .action(async (identityKeyOrEmail, nameOrIndex) => {
        const info = loadCARSConfigInfo();
        const cfg = await pickCARSConfig(info, nameOrIndex);
        if (!cfg.projectID) {
            console.error(chalk.red('❌ No project ID set in this configuration.'));
            process.exit(1);
        }
        const client = await buildAuthFetch(cfg);
        const result = await safeRequest(client, cfg.CARSCloudURL, `/api/v1/project/${cfg.projectID}/addAdmin`, { identityKeyOrEmail });
        if (result.message) {
            console.log(chalk.green(`✅ ${result.message}`));
        } else {
            console.error(chalk.red(`❌ ${result.error || 'Could not add project admin.'}`));
        }
    });

// Remove admin
projectCommand
    .command('remove-admin <identityKeyOrEmail> [nameOrIndex]')
    .description('Remove an admin from the project of the chosen configuration')
    .action(async (identityKeyOrEmail, nameOrIndex) => {
        const info = loadCARSConfigInfo();
        const cfg = await pickCARSConfig(info, nameOrIndex);
        if (!cfg.projectID) {
            console.error(chalk.red('❌ No project ID set in this configuration.'));
            process.exit(1);
        }
        const client = await buildAuthFetch(cfg);
        const rmResult = await safeRequest(client, cfg.CARSCloudURL, `/api/v1/project/${cfg.projectID}/removeAdmin`, { identityKeyOrEmail });
        if (rmResult.message) {
            console.log(chalk.green(`✅ ${rmResult.message}`));
        } else {
            console.error(chalk.red(`❌ ${rmResult.error || 'Could not remove project admin.'}`));
        }
    });

// List admins
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
        const client = await buildAuthFetch(cfg);
        const result = await safeRequest<{ admins: AdminInfo[] }>(client, cfg.CARSCloudURL, `/api/v1/project/${cfg.projectID}/admins/list`, {});
        if (result && result.admins) printAdminsList(result.admins);
    });

// Project logs
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
        const client = await buildAuthFetch(cfg);
        const result = await safeRequest<{ logs: string }>(client, cfg.CARSCloudURL, `/api/v1/project/${cfg.projectID}/logs/project`, {});
        if (result) printLogs(result.logs, 'Project Logs');
    });

// Resource logs
projectCommand
    .command('resource-logs [nameOrIndex]')
    .description('View resource logs from the cluster for this project')
    .option('--resource <resource>', 'Resource type: frontend|backend|mongo|mysql')
    .option('--since <period>', 'Time period (one of: 5m,15m,30m,1h,2h,6h,12h,1d,2d,7d)', '1h')
    .option('--tail <lines>', 'Number of lines (1-10000)', '1000')
    .option('--level <level>', 'Log level: all|error|warn|info', 'all')
    .action(async (nameOrIndex, options) => {
        const info = loadCARSConfigInfo();
        const cfg = await pickCARSConfig(info, nameOrIndex);
        await fetchResourceLogs(cfg, {
            resource: options.resource,
            since: options.since,
            tail: parseInt(options.tail, 10),
            level: options.level
        });
    });

// List releases
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
        const client = await buildAuthFetch(cfg);
        const result = await safeRequest<{ deploys: DeployInfo[] }>(client, cfg.CARSCloudURL, `/api/v1/project/${cfg.projectID}/deploys/list`, {});
        if (result && Array.isArray(result.deploys)) {
            printReleasesList(result.deploys);
        }
    });

// Set frontend domain non-interactive
projectCommand
    .command('domain:frontend <domain> [nameOrIndex]')
    .description('Set the frontend custom domain for the project of the chosen configuration (non-interactive)')
    .action(async (domain, nameOrIndex) => {
        const info = loadCARSConfigInfo();
        const cfg = await pickCARSConfig(info, nameOrIndex);
        await setCustomDomain(cfg, 'frontend', domain, false);
    });

// Set backend domain non-interactive
projectCommand
    .command('domain:backend <domain> [nameOrIndex]')
    .description('Set the backend custom domain for the project of the chosen configuration (non-interactive)')
    .action(async (domain, nameOrIndex) => {
        const info = loadCARSConfigInfo();
        const cfg = await pickCARSConfig(info, nameOrIndex);
        await setCustomDomain(cfg, 'backend', domain, false);
    });

// Web UI config: view
projectCommand
    .command('webui-config:view [nameOrIndex]')
    .description('View the current Web UI config of the project')
    .action(async (nameOrIndex) => {
        const info = loadCARSConfigInfo();
        const cfg = await pickCARSConfig(info, nameOrIndex);
        if (!cfg.projectID) {
            console.error(chalk.red('❌ No project ID.'));
            process.exit(1);
        }
        const client = await buildAuthFetch(cfg);
        const projectInfo = await safeRequest<ProjectInfo>(client, cfg.CARSCloudURL, `/api/v1/project/${cfg.projectID}/info`, {});
        if (projectInfo && projectInfo.webUIConfig) {
            const wtable = new Table({ head: ['Key', 'Value'] });
            Object.keys(projectInfo.webUIConfig).forEach(k => wtable.push([k, JSON.stringify(projectInfo.webUIConfig[k])]));
            console.log(wtable.toString());
        } else {
            console.log(chalk.yellow('No Web UI config found.'));
        }
    });

// Web UI config: set key
projectCommand
    .command('webui-config:set <key> <value> [nameOrIndex]')
    .description('Set (add/update) a key in the Web UI config of the project')
    .action(async (key, value, nameOrIndex) => {
        const info = loadCARSConfigInfo();
        const cfg = await pickCARSConfig(info, nameOrIndex);
        if (!cfg.projectID) {
            console.error(chalk.red('❌ No project ID.'));
            process.exit(1);
        }

        let parsedVal: any = value;
        try {
            parsedVal = JSON.parse(value);
        } catch (_) {
            // Not JSON, treat as string
        }

        const client = await buildAuthFetch(cfg);
        const projectInfo = await safeRequest<ProjectInfo>(client, cfg.CARSCloudURL, `/api/v1/project/${cfg.projectID}/info`, {});
        if (!projectInfo) return;
        const webUIConfig = projectInfo.webUIConfig || {};
        webUIConfig[key] = parsedVal;

        const resp = await safeRequest(client, cfg.CARSCloudURL, `/api/v1/project/${cfg.projectID}/webui/config`, { config: webUIConfig });
        if (resp) {
            console.log(chalk.green('✅ Web UI config updated.'));
        }
    });

// Web UI config: delete key
projectCommand
    .command('webui-config:delete <key> [nameOrIndex]')
    .description('Delete a key from the Web UI config of the project')
    .action(async (key, nameOrIndex) => {
        const info = loadCARSConfigInfo();
        const cfg = await pickCARSConfig(info, nameOrIndex);
        if (!cfg.projectID) {
            console.error(chalk.red('❌ No project ID.'));
            process.exit(1);
        }

        const client = await buildAuthFetch(cfg);
        const projectInfo = await safeRequest<ProjectInfo>(client, cfg.CARSCloudURL, `/api/v1/project/${cfg.projectID}/info`, {});
        if (!projectInfo) return;
        const webUIConfig = projectInfo.webUIConfig || {};
        if (!(key in webUIConfig)) {
            console.log(chalk.yellow(`Key "${key}" not found in config.`));
            return;
        }
        delete webUIConfig[key];

        const resp = await safeRequest(client, cfg.CARSCloudURL, `/api/v1/project/${cfg.projectID}/webui/config`, { config: webUIConfig });
        if (resp) {
            console.log(chalk.green('✅ Web UI config updated.'));
        }
    });

// Billing stats
projectCommand
    .command('billing-stats [nameOrIndex]')
    .description('View billing statistics for the project. You can specify filters with options.')
    .option('--start <date>', 'Start date (YYYY-MM-DD)')
    .option('--end <date>', 'End date (YYYY-MM-DD)')
    .option('--type <type>', 'Type of records: all|debit|credit', 'all')
    .action(async (nameOrIndex, options) => {
        const info = loadCARSConfigInfo();
        const cfg = await pickCARSConfig(info, nameOrIndex);

        if (!cfg.projectID) {
            console.error(chalk.red('❌ No project ID set.'));
            process.exit(1);
        }

        const data: any = {};
        if (options.start) data.start = new Date(options.start.trim()).toISOString();
        if (options.end) data.end = new Date(options.end.trim()).toISOString();
        if (options.type && options.type !== 'all') data.type = options.type;

        const client = await buildAuthFetch(cfg);
        const records = await safeRequest<{ records: AccountingRecord[] }>(client, cfg.CARSCloudURL, `/api/v1/project/${cfg.projectID}/billing/stats`, data);
        if (!records) return;

        if (records.records.length === 0) {
            console.log(chalk.yellow('No billing records found for specified filters.'));
            return;
        }

        const table = new Table({ head: ['Timestamp', 'Type', 'Amount (sats)', 'Balance After', 'Metadata'] });
        records.records.forEach(r => {
            table.push([new Date(r.timestamp).toLocaleString(), r.type, r.amount_sats, r.balance_after, JSON.stringify(r.metadata, null, 2)]);
        });
        console.log(table.toString());
    });

// Top up balance
projectCommand
    .command('topup [nameOrIndex]')
    .description('Top up the project balance. If --amount is not specified, you will be prompted.')
    .option('--amount <sats>', 'Amount in satoshis to add')
    .action(async (nameOrIndex, options) => {
        const info = loadCARSConfigInfo();
        const cfg = await pickCARSConfig(info, nameOrIndex);

        if (!cfg.projectID) {
            console.error(chalk.red('❌ No project ID set.'));
            process.exit(1);
        }

        let amount = options.amount ? parseInt(options.amount, 10) : undefined;
        if (!amount || amount <= 0) {
            const answers = await inquirer.prompt([
                { type: 'number', name: 'amount', message: 'Enter amount in satoshis to add:', validate: (val: number) => val > 0 ? true : 'Amount must be positive.' }
            ]);
            amount = answers.amount;
        }

        const client = await buildAuthFetch(cfg);

        // TODO: ACTUALLY IMPLEMENT PAYMENT
        const result = await safeRequest(client, cfg.CARSCloudURL, `/api/v1/project/${cfg.projectID}/pay`, { amount });
        if (result) {
            console.log(chalk.green(`✅ Balance topped up by ${amount} sats.`));
        }
    });

// Delete project
projectCommand
    .command('delete [nameOrIndex]')
    .description('Delete the project. This cannot be undone. Use --force to confirm.')
    .option('--force', 'Skip confirmation prompts')
    .action(async (nameOrIndex, options) => {
        const info = loadCARSConfigInfo();
        const cfg = await pickCARSConfig(info, nameOrIndex);

        if (!cfg.projectID) {
            console.error(chalk.red('❌ No project ID set.'));
            process.exit(1);
        }

        if (!options.force) {
            const { confirm } = await inquirer.prompt([
                { type: 'confirm', name: 'confirm', message: 'Are you ABSOLUTELY SURE you want to delete this project?', default: false }
            ]);
            if (!confirm) return;

            const { confirmAgain } = await inquirer.prompt([
                { type: 'confirm', name: 'confirmAgain', message: 'Really delete the entire project and all its data permanently?', default: false }
            ]);
            if (!confirmAgain) return;
        }

        const client = await buildAuthFetch(cfg);
        const result = await safeRequest(client, cfg.CARSCloudURL, `/api/v1/project/${cfg.projectID}/delete`, {});
        if (result) {
            console.log(chalk.green('✅ Project deleted.'));
        }
    });

projectCommand.action(async () => {
    await projectMenu();
});


// Release management
const releaseCommand = program
    .command('release')
    .description('Manage releases');

// Get upload URL for a new release
releaseCommand
    .command('get-upload-url [nameOrIndex]')
    .description('Create a new release for a chosen CARS configuration and get the upload URL')
    .action(async (nameOrIndex) => {
        const info = loadCARSConfigInfo();
        const cfg = await pickCARSConfig(info, nameOrIndex);
        if (!cfg.projectID) {
            console.error(chalk.red('❌ No project ID set.'));
            process.exit(1);
        }
        const client = await buildAuthFetch(cfg);
        const result = await safeRequest<{ url: string, deploymentId: string }>(client, cfg.CARSCloudURL, `/api/v1/project/${cfg.projectID}/deploy`, {});
        if (result && result.url && result.deploymentId) {
            console.log(chalk.green(`✅ Release created. Release ID: ${result.deploymentId}`));
            console.log(`Upload URL: ${result.url}`);
        }
    });

// Upload artifact to given URL
releaseCommand
    .command('upload-files <uploadURL> <artifactPath>')
    .description('Upload a built artifact to the given URL')
    .action(async (uploadURL, artifactPath) => {
        await uploadArtifact(uploadURL, artifactPath);
    });

// View logs of a release
releaseCommand
    .command('logs [releaseId] [nameOrIndex]')
    .description('View logs of a release by its ID. If no releaseId is provided, select from a menu.')
    .action(async (releaseId, nameOrIndex) => {
        const info = loadCARSConfigInfo();
        const cfg = await pickCARSConfig(info, nameOrIndex);
        if (!cfg.projectID) {
            console.error(chalk.red('❌ No project ID set.'));
            process.exit(1);
        }

        const finalReleaseId = await pickReleaseId(cfg, releaseId);
        if (!finalReleaseId) return;

        const client = await buildAuthFetch(cfg);
        const result = await safeRequest<{ logs: string }>(client, cfg.CARSCloudURL, `/api/v1/project/${cfg.projectID}/logs/deployment/${finalReleaseId}`, {});
        if (result) printLogs(result.logs, 'Release Logs');
    });

// Create new release and upload latest artifact immediately
releaseCommand
    .command('now [nameOrIndex]')
    .description('Create a new release and automatically upload the latest artifact')
    .action(async (nameOrIndex) => {
        const info = loadCARSConfigInfo();
        const cfg = await pickCARSConfig(info, nameOrIndex);

        if (!cfg.projectID) {
            console.error(chalk.red('❌ No project ID set.'));
            process.exit(1);
        }

        const artifactPath = findLatestArtifact();
        const client = await buildAuthFetch(cfg);
        const result = await safeRequest<{ url: string, deploymentId: string }>(client, cfg.CARSCloudURL, `/api/v1/project/${cfg.projectID}/deploy`, {});
        if (result && result.url && result.deploymentId) {
            await uploadArtifact(result.url, artifactPath);
        }
    });

releaseCommand.action(async () => {
    await releaseMenu();
});


// Artifact management
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

artifactCommand.action(async () => {
    await artifactMenu();
});


// Global public info
program
    .command('global-info [nameOrIndex]')
    .description('View global public info (public keys, pricing, etc.) from a chosen CARS Cloud')
    .action(async (nameOrIndex) => {
        const info = loadCARSConfigInfo();
        const chosenURL = await chooseCARSCloudURL(info, nameOrIndex);
        const spinner = ora('Fetching global public info...').start();
        try {
            const res = await axios.get(`${chosenURL}/api/v1/public`);
            spinner.succeed('✅ Fetched global info:');
            const data = res.data;
            console.log(chalk.blue('Mainnet Public Key:'), data.mainnetPublicKey);
            console.log(chalk.blue('Testnet Public Key:'), data.testnetPublicKey);
            console.log(chalk.blue('Pricing:'));
            const table = new Table({ head: ['Resource', 'Cost (per 5m)'] });
            table.push(['CPU (per core)', data.pricing.cpu_rate_per_5min + ' sat']);
            table.push(['Memory (per GB)', data.pricing.mem_rate_per_gb_5min + ' sat']);
            table.push(['Disk (per GB)', data.pricing.disk_rate_per_gb_5min + ' sat']);
            table.push(['Network (per GB)', data.pricing.net_rate_per_gb_5min + ' sat']);
            console.log(table.toString());
            console.log(chalk.blue('Project Deployment Domain:'), data.projectDeploymentDomain);
        } catch (error: any) {
            spinner.fail('❌ Failed to fetch public info.');
            handleRequestError(error);
        }
    });


// If `cars` is invoked without args, enter the main menu
(async function main() {
    if (process.argv.length <= 2) {
        if (!fs.existsSync(CONFIG_PATH)) {
            console.log(chalk.yellow('No deployment-info.json found. Creating a basic one.'));
            const basicInfo: CARSConfigInfo = {
                schema: 'bsv-app',
                schemaVersion: '1.0'
            };
            saveCARSConfigInfo(basicInfo);
        }

        const info = loadCARSConfigInfo();
        if ((info.configs || []).filter(isCARSConfig).length === 0) {
            console.log(chalk.yellow('No CARS configurations found. Let’s create one.'));
            await addCARSConfigInteractive(info);
        }

        // Enter main menu interactively
        await mainMenu();
    } else {
        program.parse(process.argv);
    }
})();
