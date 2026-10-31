'use strict';

const vscode = require('vscode');
const path = require('path');
const { homedir } = require('os');
const { readHtml, getSettings } = require('./util');
const { copyPngWithSystemTools } = require('./clipboard');

const getConfig = () => {
  const editorSettings = getSettings('editor', ['fontLigatures', 'tabSize']);
  const editor = vscode.window.activeTextEditor;
  if (editor) editorSettings.tabSize = editor.options.tabSize;

  const extensionSettings = getSettings('codesnap-plus', [
    'backgroundColor',
    'boxShadow',
    'containerPadding',
    'roundedCorners',
    'showWindowControls',
    'showWindowTitle',
    'showLineNumbers',
    'realLineNumbers',
    'transparentBackground',
    'target',
    'shutterAction',
    'toolMode'
  ]);

  const selection = editor && editor.selection;
  const startLine = extensionSettings.realLineNumbers ? (selection ? selection.start.line : 0) : 0;

  let windowTitle = '';
  if (editor && extensionSettings.showWindowTitle) {
    const activeFileName = editor.document.uri.path.split('/').pop();
    windowTitle = `${vscode.workspace.name} - ${activeFileName}`;
  }

  return {
    ...editorSettings,
    ...extensionSettings,
    startLine,
    windowTitle
  };
};

const createPanel = async (context) => {
  const panel = vscode.window.createWebviewPanel(
    'codesnap',
    'CodeSnap 📸',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(context.extensionPath)]
    }
  );
  panel.webview.html = await readHtml(
    path.resolve(context.extensionPath, 'webview/index.html'),
    panel
  );

  return panel;
};

let lastUsedImageUri = vscode.Uri.file(path.resolve(homedir(), 'Desktop/code.png'));
let saveDialogOpen = false;

// `image` settles with the webview's `{ data }` or `{ error }`; the webview renders while the
// user is still picking a file name.
const saveImage = async (image) => {
  if (saveDialogOpen) return;
  saveDialogOpen = true;
  let uri;
  try {
    uri = await vscode.window.showSaveDialog({
      filters: { Images: ['png'] },
      defaultUri: lastUsedImageUri
    });
  } finally {
    saveDialogOpen = false;
  }
  if (!uri) return;
  lastUsedImageUri = uri;
  const { data, error } = await image;
  if (error) throw new Error(error);
  await vscode.workspace.fs.writeFile(uri, data);
};

// The webview hands over images too large for its own clipboard API.
const copyLargeImage = async (context, data) => {
  // A remote extension host would fill the remote machine's clipboard instead.
  if (vscode.env.remoteName && context.extension.extensionKind !== vscode.ExtensionKind.UI) {
    throw new Error('This image is too large for the clipboard here, use Save instead.');
  }
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'CodeSnap 📸: Copying a large image to the clipboard...'
    },
    () => copyPngWithSystemTools(data)
  );
};

const hasOneSelection = (selections) =>
  selections && selections.length === 1 && !selections[0].isEmpty;

const runCommand = async (context) => {
  const panel = await createPanel(context);

  panel.webview.postMessage({ type: 'setup-ui', ...getConfig() });

  const update = async () => {
    await vscode.commands.executeCommand('editor.action.clipboardCopyWithSyntaxHighlightingAction');
    panel.webview.postMessage({ type: 'update', ...getConfig() });
  };

  const pendingImages = new Map();

  panel.webview.onDidReceiveMessage(async ({ type, id, ...message }) => {
    try {
      if (type === 'save') {
        await saveImage(new Promise((resolve) => pendingImages.set(id, resolve)));
      } else if (type === 'image') {
        const resolve = pendingImages.get(id);
        pendingImages.delete(id);
        if (resolve) resolve(message);
      } else if (type === 'copy') {
        await copyLargeImage(context, message.data);
      } else if (type === 'error') {
        throw new Error(message.message);
      } else {
        vscode.window.showErrorMessage(`CodeSnap 📸: Unknown shutterAction "${type}"`);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`CodeSnap 📸: ${err.message}`);
    }
  });

  const selectionHandler = vscode.window.onDidChangeTextEditorSelection(
    (e) => hasOneSelection(e.selections) && update()
  );
  panel.onDidDispose(() => selectionHandler.dispose());

  const editor = vscode.window.activeTextEditor;
  if (editor && hasOneSelection(editor.selections)) update();
};

module.exports.activate = (context) =>
  context.subscriptions.push(
    vscode.commands.registerCommand('codesnap-plus-fix.start', () => runCommand(context))
  );
