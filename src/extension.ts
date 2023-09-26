import * as vscode from 'vscode'

import { exec } from 'child_process'
import { getExtensionCommandId, registerExtensionCommand } from 'vscode-framework'
import { promisify } from 'util'
import { isAbsolute } from 'path'
import { ExecaReturnValue, execa } from 'execa'

export const activate = () => {
    let fileContent
    let onDidChangeEvent = new vscode.EventEmitter<vscode.Uri>()
    vscode.workspace.registerTextDocumentContentProvider('eslint-migrate', {
        provideTextDocumentContent(uri, token) {
            return fileContent
        },
        onDidChange: onDidChangeEvent.event
    })
    const toDispose: vscode.Disposable[] = []
    registerExtensionCommand('run', async () => {
        vscode.Disposable.from(...toDispose).dispose()
        const glob = await vscode.window.showInputBox({ placeHolder: 'Enter glob pattern', value: 'src/**/*.ts' })
        if (!glob) return
        const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        if (!workspaceCwd) return

        const cmd = `pnpm eslint ${glob} --format json`
        const cmdParts = cmd.split(' ')
        let res!: ExecaReturnValue<string>
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Running eslint...',
        }, async () => {
            res = await execa(cmdParts[0]!, cmdParts.slice(1), {
                cwd: workspaceCwd,
                reject: false,
            })
        })
        const {stdout, exitCode, stderr} = res
        if (exitCode !== 1 && exitCode !== 0) throw new Error(stderr)
        type Entry = { filePath: string, messages: { line: number, column: number, ruleId: string, message }[] }
        const parsed = JSON.parse(stdout) as Entry[]
        const problemsByRuleId = {} as Record<string, { filePath: string, line: number, column: number, message }[]>
        for (const {filePath, messages} of parsed) {
            for (const message of messages) {
                problemsByRuleId[message.ruleId] ??= []

                problemsByRuleId[message.ruleId]!.push({
                    filePath,
                    line: message.line,
                    column: message.column,
                    message: message.message
                })
            }
        }
        const problemsByRuleIdSorted = Object.fromEntries(Object.entries(problemsByRuleId).sort((a, b) => b[1].length - a[1].length))
        const fileUri = vscode.Uri.parse('eslint-migrate://rules.md');

        const formFileContent = () => {
            fileContent = ''
            Object.entries(problemsByRuleIdSorted).forEach(([ruleId, problems]) => {
                if (!problems.length) return
                fileContent += `## ${ruleId} (${problems.length}) | ${Object.keys(ruleActions).join(' | ')}\n`
                problems.forEach(problem => {
                    const pathShort = problem.filePath.slice(workspaceCwd.length + 1)
                    fileContent += `* ${pathShort}:${problem.line}:${problem.column} | (${problem.message})\n`
                })
                fileContent += '\n'
            })
            onDidChangeEvent.fire(fileUri)
        }
        const executeCommand = (isRule, command, index, problemIndex?) => {
            if (isRule) {
                const rule = Object.entries(problemsByRuleIdSorted)[index]![0]
                ruleActions[command](rule)
            }
        }
        const executeCommandId = getExtensionCommandId('executeCommand' as any)
        vscode.commands.registerCommand(executeCommandId, executeCommand)
        let eslintFile: vscode.Uri[] | undefined
        // todo problem actions (fix, ignore)
        const ruleActions = {
            fix: async (ruleId) => {
                const { stderr } = await promisify(exec)(['eslint-filtered-fix', `"${glob}"`, '--rule', ruleId].join(' '), {
                    cwd: workspaceCwd,
                })
                console.log(stderr)
                problemsByRuleIdSorted[ruleId] = []
                formFileContent()
            },
            disable: async (ruleId) => {
                eslintFile = await vscode.window.showOpenDialog({
                    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
                    filters: {
                        'eslint json config': ['json']
                    },
                })
                if (!eslintFile) {
                    return
                }
                const config = require(eslintFile[0]!.fsPath)
                config.rules[ruleId] = 'off'
                await vscode.workspace.fs.writeFile(eslintFile[0]!, Buffer.from(JSON.stringify(config, null, 2)))
                problemsByRuleIdSorted[ruleId] = []
                formFileContent()
            },
            ignore: (ruleId) => {
                problemsByRuleIdSorted[ruleId] = []
                formFileContent()
            }
        }

        const linkProvider = vscode.languages.registerDocumentLinkProvider({
            scheme: 'eslint-migrate',
        }, {
            provideDocumentLinks(document, token) {
                const links: vscode.DocumentLink[] = []
                const lines = document.getText().split('\n')
                let ruleIndex = 0
                for (const [lineNum, line] of lines.entries()) {
                    if (line.startsWith('##')) {
                        const repl = ' | '
                        line.split(repl).forEach((x, i, arr) => {
                            if (i === 0) return
                            const length = (arr.slice(0, i).join(repl)+repl).length
                            const command = x.trim()
                            const index = ruleIndex
                            links.push(new vscode.DocumentLink(new vscode.Range(lineNum, length, lineNum, length + command.length),
                            vscode.Uri.parse(`command:${executeCommandId}?${JSON.stringify([true, command, index])}`),
                            ))
                        })
                        ruleIndex++
                    }
                    // todo refactor (lib?)
                    if (line.startsWith('* ')) {
                        const start = '* '.length
                        const [filePath] = line.slice(start).split(' | ')
                        const parts = filePath!.split(':')
                        const fileColumn = parts.pop()!
                        const fileLine = parts.pop()!
                        let path = parts.join(':')
                        if (!isAbsolute(path)) {
                            path = workspaceCwd + '/' + path
                        }
                        const uri = vscode.Uri.file(path)
                        links.push(new vscode.DocumentLink(new vscode.Range(lineNum, start, lineNum, filePath!.length + start), uri.with({ fragment: `L${fileLine},${fileColumn}` })))
                    }
                }
                return links
            },
        })
        toDispose.push(linkProvider)

        formFileContent()

        const doc = await vscode.window.showTextDocument(fileUri, {
            preview: false,
        })
        vscode.languages.setTextDocumentLanguage(doc.document, 'markdown')
    })
}
