/* eslint-disable prettier/prettier */
/* eslint-disable import/no-extraneous-dependencies */
import chalk from 'chalk';
import * as cp from 'child_process';
import executionTime from 'execution-time';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { globby } from 'globby';
import { hideBin } from 'yargs/helpers';
import path from 'path';
import recast from 'recast';
import * as rollup from 'rollup';
import rollupPluginCommonJs from '@rollup/plugin-commonjs';
import rollupPluginNodePolyfills from 'rollup-plugin-polyfill-node';
import rollupPluginNodeResolve from '@rollup/plugin-node-resolve';
import tempfile from 'tempfile';
import yargs from 'yargs';

const TEST_BOOTSTRAP_PATH = 'test/__bootstrap__/';
const TEST_BOOTSTRAP_BUILD_PATH = 'test/__bootstrap__/build/';

const EXPECT_BUILD_PATH = path.join(TEST_BOOTSTRAP_BUILD_PATH, 'expect.js');
const SETUP_BUILD_PATH = path.join(TEST_BOOTSTRAP_BUILD_PATH, 'setup.js');

function preprocessor(ast) {
    recast.visit(ast, {
        visitIdentifier(path) {
            if (path.value.type === 'Identifier' && path.value.name === 'window') {
                path.value.name = 'globalThis';
            }
            this.traverse(path);
        },
        visitNode(path) {
            if (path.node.type === 'Program') {
                const body = [];
                for (const node of path.node.body) {
                    if (node.type !== 'ImportDeclaration') {
                        body.push(node);
                    }
                }
                path.node.body = body;
            }
            this.traverse(path);
        },
    });
    return ast;
}

const ignoredWarningFragments = ['Use of eval is strongly discouraged', 'Circular dependency:'];

const onwarn = ({ message }) => {
    const isIgnorable = ignoredWarningFragments.some((ignoredWarningFragment) =>
        message.includes(ignoredWarningFragment)
    );
    if (isIgnorable) {
        return;
    }
    console.warn(message);
};

async function cleanBootstrapEnvironment() {
    await fsp.rm(TEST_BOOTSTRAP_BUILD_PATH, { recursive: true, force: true });
}

async function generateBootstrapEnvironment() {
    const expectBuildFileExists = fs.existsSync(EXPECT_BUILD_PATH);
    const setupBuildFileExists = fs.existsSync(SETUP_BUILD_PATH);

    if (!expectBuildFileExists || !setupBuildFileExists) {
        const expectOutputOptions = {
            file: EXPECT_BUILD_PATH,
            format: 'iife',
            name: 'expect',
        };
        // The jasmine tests that near-membrane-embedded is borrowing from near-membrane-node
        // were written to run in jest and take advantage of jest's extended expect API.
        // In order to provide that API to our embedded environment, we need to run it through
        // rollup.
        const expectBundle = await rollup.rollup({
            input: './node_modules/expect/build/index.js',
            plugins: [
                // For reasons I cannot explain, it appears that this order matters!
                rollupPluginCommonJs(),
                rollupPluginNodePolyfills(),
                rollupPluginNodeResolve(),
            ],
            onwarn,
        });

        const setupOutputOptions = {
            file: SETUP_BUILD_PATH,
            format: 'es',
        };

        const setupBundle = await rollup.rollup({
            context: 'globalThis',
            input: path.join(TEST_BOOTSTRAP_PATH, 'jasmine-setup.js'),
            onwarn,
        });

        await expectBundle.write(expectOutputOptions);
        await setupBundle.write(setupOutputOptions);

        const [expectSourceText, setupSourceText] = await Promise.all([
            await expectBundle.generate(expectOutputOptions).then(({ output }) => output[0].code),
            await setupBundle.generate(setupOutputOptions).then(({ output }) => output[0].code),
        ]);

        return {
            expectSourceText,
            setupSourceText,
        };
    }
    const expectSourceText = await fsp.readFile(EXPECT_BUILD_PATH, 'utf8');
    const setupSourceText = await fsp.readFile(SETUP_BUILD_PATH, 'utf8');
    return {
        expectSourceText,
        setupSourceText,
    };
}

async function prepareAndRunTests(options) {

    // List of engines we'll actually use for running tests.
    const enginesToTest = ['jsc', 'v8'];

    // Gather information about available engines from the esvu generated status settings.
    const engineStatusJSON = await fsp.readFile('./status.json', 'utf8');
    const engineStatus = engineStatusJSON ? JSON.parse(engineStatusJSON) : null;
    const enginesInstalled = engineStatus ? Object.keys(engineStatus.installed) : [];

    // This is complete bundled & embed-safe source for near-membrane-embedded.
    // It includes all of near-membrane-base and near-membrane-embedded
    const nearMembraneSourceText = await fsp.readFile('./lib/index.js', 'utf8');

    // This provides necessary environment definitions for running jasmine in an embedded host
    const environmentSourceText = await fsp.readFile(path.join(TEST_BOOTSTRAP_PATH, 'environment.js'), 'utf8');

    // This provides a bare-bones jasmine test results reporter. The output is JSON, which
    // is printed to stdout by the shelled binary invocation. The JSON is captured and parsed
    // and used to report test run condition.
    const jasmineReporterSourceText = await fsp.readFile(
        path.join(TEST_BOOTSTRAP_PATH, 'jasmine-reporter.js'),
        'utf8'
    );

    // This provides the jasmine test suite invocation machinery
    const jasmineExecSourceText = await fsp.readFile(path.join(TEST_BOOTSTRAP_PATH, 'jasmine-exec.js'), 'utf8');

    const {
        expectSourceText,
        setupSourceText,
    } = await generateBootstrapEnvironment();

    // Gather and prepare test source file material. We're borrowing near-membrane-node's tests
    // because those will not have references to DOM APIs.
    // TODO: This should be configurable via CLI, with reasonable default
    const rawTestFiles = await globby('../near-membrane-node/src/__tests__/*.spec.js');
    const preparedTests = await Promise.all(
        rawTestFiles.map(
            (file) =>
                new Promise((resolve) => {
                    const source = fs.readFileSync(file, 'utf8');
                    const ast = preprocessor(recast.parse(source));
                    const processedTestMaterialSourceText = recast.print(ast).code;
                    // This builds the entire test environment with the test material itself
                    // to run directly in an embedded runtime via shell.
                    const prepared = `
                ${environmentSourceText}

                ${setupSourceText}

                ${expectSourceText}

                ${jasmineReporterSourceText}

                ${nearMembraneSourceText}

                ${processedTestMaterialSourceText}

                ${jasmineExecSourceText}
                `;

                    resolve({
                        file,
                        prepared,
                    });
                })
        )
    );

    const outcomes = [];
    const tempfiles = {};
    for (const engine of enginesToTest) {
        if (!enginesInstalled.includes(engine)) {
            continue;
        }
        const capture = [];
        outcomes.push([engine, capture]);
        for (const test of preparedTests) {
            let tf = tempfiles[test.file];

            if (!tf) {
                const ntf = tempfile();
                fs.writeFileSync(ntf, test.prepared);
                tf = tempfiles[test.file] = ntf;
            }

            const spawn = cp.spawnSync(`./engines/${engine}`, [tf], { detached: true });

            if (spawn.stderr == null && spawn.stdout == null) {
                console.log(chalk.bgRed(`SPAWN ERROR: ${spawn.error}`));
                process.exitCode = 1;
            }

            const rawStderr = spawn.stderr.toString();
            const rawStdout = spawn.stdout.toString();

            if (rawStderr) {
                console.log(chalk.bgRed(`ENVIRONMENT ERROR: ${rawStderr}`));
                process.exitCode = 1;
            } else {
                try {
                    capture.push([test.file, JSON.parse(rawStdout)]);
                } catch (error) {
                    // TODO: Should this be printed and followed by process exit?
                    console.log([test.file, error.message, rawStdout]);
                }
            }
        }
    }

    const failures = [];

    if (!options.shush && outcomes.length) {
        console.log('\n');
    }

    outcomes.forEach(([engine, results]) => {
        results.forEach(([testFile, specResults]) => {
            specResults.forEach((specResult) => {
                // eslint-disable-next-line no-unused-expressions
                !options.shush && console.log(
                    `(${engine}) ${specResult.fullName}: ${chalk.green(specResult.status.toUpperCase())}`
                );
                // console.log(specResult);
                if (specResult.status === 'failed') {
                    failures.push({
                        engine,
                        specResult,
                        testFile,
                    });
                }
            });
        });
    });

    failures.forEach((failure) => {
        const { engine, specResult } = failure;
        specResult.failedExpectations.forEach((expectation) => {
            console.log(`${chalk.red('_'.repeat(process.stdout.columns))}\n`);
            console.log(`(${engine}) ${specResult.fullName}: ${chalk.red(specResult.status.toUpperCase())}`);
            console.log(`${chalk.red(expectation.message)}`);
            console.log('\n');
        });
    });

    if (failures.length) {
        process.exitCode = 1;
    }
}

async function invokeLabeledCommand(label, command, options) {
    // eslint-disable-next-line no-unused-expressions
    !options.shush && process.stdout.write(`${label}...`);
    await command(options);
    // eslint-disable-next-line no-unused-expressions
    !options.shush && process.stdout.write('Complete\n');
}

async function timedInvokeLabeledCommand(options, operation) {
    const timer = executionTime();
    timer.start();
    await operation();
    const results = timer.stop();
    // eslint-disable-next-line no-unused-expressions
    !options.shush && console.log(`(${results.words})`);
}

const builderNoop = () => {};

// eslint-disable-next-line no-unused-expressions
yargs(hideBin(process.argv))
    .command(
        'bootstrap',
        'Generate bootstrap for JavaScript shell environments.',
        builderNoop,
        async (options) => {
            await timedInvokeLabeledCommand(options, async () => {
                // When the bootstrap command is explicit called, run clean first!
                await invokeLabeledCommand('Clean', cleanBootstrapEnvironment, options);
                await invokeLabeledCommand('Bootstrap', generateBootstrapEnvironment, options);
            });
        }
    )
    .command(
        'clean',
        'Remove generated bootstrap files.',
        builderNoop,
        async (options) => {
            await timedInvokeLabeledCommand(options, async () => {
                await invokeLabeledCommand('Clean', cleanBootstrapEnvironment, options);
            });
        }
    )
    .command(
        'exec',
        'Execute tests in JavaScript shell environments.',
        builderNoop,
        async (options) => {
            await timedInvokeLabeledCommand(options, async () => {
                await invokeLabeledCommand('Running', prepareAndRunTests, options);
            });
        }
    )
    .option('s', {
        alias: 'shush',
        demandOption: false,
        default: false,
        describe: 'Suppress all output that is not an error or failure.',
        type: 'boolean'
    })
    .demandCommand(1).argv;

