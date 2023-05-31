const vscode = require('vscode');
const chokidar = require('chokidar');
const pythonShell = require('python-shell');
const nodePath = require('path');
const _ = require('lodash');
const { Version, getCMakeToolsApi } = require('vscode-cmake-tools');

const posixPath = nodePath.posix || nodePath;

function dirnameUri(uri) {
	return uri.with({ path: posixPath.dirname(uri.path) });
}

class CompDBRunner {
	#compileCommandsSourceCandidates = []
	#workspaceFolder = null
	#compileCommandsSourceWatchers = null

	get workspaceFolder() {
		return this.#workspaceFolder
	}

	constructor(workspaceFolder) {
		this.#workspaceFolder = workspaceFolder
		this.#compileCommandsSourceWatchers = this.#createCompilerCommandsSourceWatchers()
	}

	async runCompDB(buildDir) {
		await this.#updateCompDB(vscode.Uri.file(posixPath.join(buildDir, 'compile_commands.json')));
	}

	async #handleCompileCommandsSourceCreated(uri) {
		this.#compileCommandsSourceCandidates.push(uri);

		const cmakeBuildDirectory = await vscode.commands.executeCommand("cmake.buildDirectory");
		if (dirnameUri(uri).fsPath !== cmakeBuildDirectory)
			return

		await this.#updateCompDB(uri);
	}

	async #handleCompileCommandsSourceChanged(uri) {
		const cmakeBuildDirectory = await vscode.commands.executeCommand("cmake.buildDirectory");
		if (dirnameUri(uri).fsPath !== cmakeBuildDirectory)
			return

		await this.#updateCompDB(uri);
	}

	async #handleCompileCommandsSourceDeleted(uri) {
		this.#compileCommandsSourceCandidates = this.#compileCommandsSourceCandidates.filter(currentUri => currentUri !== uri);
	}

	#createCompilerCommandsSourceWatchers() {
		const compileCommandsSourceWatchers = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.#workspaceFolder, '*/compile_commands.json'), false, false, false)

		compileCommandsSourceWatchers.onDidCreate(this.#handleCompileCommandsSourceCreated, this)
		compileCommandsSourceWatchers.onDidChange(this.#handleCompileCommandsSourceChanged, this)
		compileCommandsSourceWatchers.onDidDelete(this.#handleCompileCommandsSourceDeleted, this)

		return compileCommandsSourceWatchers
	}

	async #runCompDB(sourceUri) {
		const run = async (localBuildDir) => {
			try {
				const response = await pythonShell.PythonShell.run('compdb', { 'args': ['-p', localBuildDir, 'list'], 'pythonOptions': ['-m'], 'mode': 'text' });
				return response.join('\n')
			} catch {
				// TODO: Handle compdb not found situation...
			}
		};

		if (sourceUri.scheme === 'file') {
			return await run(dirnameUri(sourceUri).fsPath);
		} else {
			// TODO: Handle this situation.
			//   maybe copy everything over to local directory and then run compdb?
		}
	}

	async #updateCompDB(sourceUri) {
		const newCompilerCommandsText = await this.#runCompDB(sourceUri);
		const newCompilerCommandsJSON = JSON.parse(newCompilerCommandsText);

		const targetUri = vscode.Uri.joinPath(this.#workspaceFolder.uri, 'compile_commands.json');
		try {
			const currentContentBytes = await vscode.workspace.fs.readFile(targetUri);

			const currentContentJson = JSON.parse(currentContentBytes);
			if (_.isEqual(currentContentJson, newCompilerCommandsJSON))
				return;
		} catch { }

		const te = new TextEncoder();

		const targetAlreadyExists = await (async () => {
			try {
				await vscode.workspace.fs.stat(targetUri);
				return true;
			} catch {
				return false;
			}
		})();

		await vscode.workspace.fs.writeFile(targetUri, te.encode(newCompilerCommandsText));

		if (!targetAlreadyExists)
			await vscode.commands.executeCommand("clangd.restart");
	}
}

class WorkspaceManager {
	#compDBRunners

	constructor() {
		this.#compDBRunners = vscode.workspace.workspaceFolders.map(
			workspaceFolder => new CompDBRunner(workspaceFolder)
		);

		vscode.workspace.onDidChangeWorkspaceFolders(this.#handleDidChangeWorkspaceFolders, this)
	}

	async runCompDB(workspaceFolder, buildDirectory) {
		console.log(` *** Reconfigure for workspace ${workspaceFolder} using build dir ${buildDirectory}`)

		await Promise.all(this.#compDBRunners
			.filter(worker => worker.workspaceFolder !== workspaceFolder)
			.forEach(worker => worker.runCompDB()))
	}

	#handleDidChangeWorkspaceFolders(workspaceFoldersChangeEvent) {
		workspaceFoldersChangeEvent.removed.forEach(removedWorkspaceFolder => {
			this.#compDBRunners = this.#compDBRunners.filter(worker => worker.workspaceFolder !== removedWorkspaceFolder)
		})
		workspaceFoldersChangeEvent.added.forEach(addedWorkspaceFolder => {
			this.#compDBRunners.push(new CompDBRunner(addedWorkspaceFolder))
		})
	}
}

let workspaceManager = null;

class CMakeManager {
	#cmakeApi = null

	constructor(api) {
		this.#cmakeApi = api

		console.log(' ** CMake API Manager:', api.manager);

		this.#handleActiveProjectChanged(api.manager.projectController.activeProject)
		api.onActiveProjectChanged(this.#handleActiveProjectChanged, this); // TODO: Verify argument
	}

	async #handleReconfigured() {
		const activeProject = this.#cmakeApi.manager.projectController.activeProject;
		const workspaceFolder = activeProject.workspaceFolder;
		const binaryDir = await activeProject.binaryDir;
		await workspaceManager.runCompDB(workspaceFolder, binaryDir);
	}

	#handleActiveProjectChanged(activeProject) {
		activeProject.onReconfigured(this.#handleReconfigured, this);
	}
}

let cmakeManager = null;

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
	workspaceManager = new WorkspaceManager()
	const api = await getCMakeToolsApi(Version.v1)
	cmakeManager = new CMakeManager(api)
}

// this method is called when your extension is deactivated
function deactivate() { }

// eslint-disable-next-line no-undef
module.exports = {
	activate,
	deactivate
}