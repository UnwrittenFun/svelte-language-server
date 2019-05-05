import ts, { NavigationTree } from 'typescript';
import URL from 'vscode-uri';
import {
    DiagnosticsProvider,
    Document,
    Diagnostic,
    Range,
    DiagnosticSeverity,
    Fragment,
    HoverProvider,
    Position,
    Hover,
    OnRegister,
    Host,
    DocumentSymbolsProvider,
    SymbolInformation,
    CompletionsProvider,
    CompletionItem,
} from '../api';
import {
    convertRange,
    getScriptKindFromAttributes,
    symbolKindFromString,
    scriptElementKindToCompletionItemKind,
    getCommitCharactersForScriptElement,
} from './typescript/utils';
import { getLanguageServiceForDocument, CreateDocument } from './typescript/service';

export class TypeScriptPlugin
    implements
        DiagnosticsProvider,
        HoverProvider,
        OnRegister,
        DocumentSymbolsProvider,
        CompletionsProvider {
    public static matchFragment(fragment: Fragment) {
        return fragment.details.attributes.tag == 'script';
    }

    public pluginId = 'typescript';
    public defaultConfig = {
        enable: true,
        diagnostics: { enable: true },
        hover: { enable: true },
    };

    private host!: Host;
    private createDocument!: CreateDocument;

    onRegister(host: Host) {
        this.host = host;
        this.createDocument = (fileName, content) => {
            const uri = URL.file(fileName).toString();
            const document = host.openDocument({
                languageId: '',
                text: content,
                uri,
                version: 0,
            });
            host.lockDocument(uri);
            return document;
        };
    }

    getDiagnostics(document: Document): Diagnostic[] {
        if (!this.host.getConfig<boolean>('typescript.diagnostics.enable')) {
            return [];
        }

        const lang = getLanguageServiceForDocument(document, this.createDocument);
        const isTypescript =
            getScriptKindFromAttributes(document.getAttributes()) === ts.ScriptKind.TS;

        let diagnostics: ts.Diagnostic[] = lang.getSyntacticDiagnostics(document.getFilePath()!);

        if (isTypescript) {
            diagnostics.push(...lang.getSemanticDiagnostics(document.getFilePath()!));
        }

        return diagnostics.map(diagnostic => ({
            range: convertRange(document, diagnostic),
            severity: DiagnosticSeverity.Error,
            source: isTypescript ? 'ts' : 'js',
            message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        }));
    }

    doHover(document: Document, position: Position): Hover | null {
        if (!this.host.getConfig<boolean>('typescript.hover.enable')) {
            return null;
        }

        const lang = getLanguageServiceForDocument(document, this.createDocument);
        const info = lang.getQuickInfoAtPosition(
            document.getFilePath()!,
            document.offsetAt(position),
        );
        if (!info) {
            return null;
        }
        let contents = ts.displayPartsToString(info.displayParts);
        return {
            range: convertRange(document, info.textSpan),
            contents: { language: 'ts', value: contents },
        };
    }

    getDocumentSymbols(document: Document): SymbolInformation[] {
        if (!this.host.getConfig<boolean>('typescript.documentSymbols.enable')) {
            return [];
        }

        const lang = getLanguageServiceForDocument(document, this.createDocument);
        const navTree = lang.getNavigationTree(document.getFilePath()!);

        const symbols: SymbolInformation[] = [];
        collectSymbols(navTree, undefined, symbol => symbols.push(symbol));

        const topContainerName = symbols[0].name;
        return symbols.slice(1).map(symbol => {
            if (symbol.containerName === topContainerName) {
                return { ...symbol, containerName: 'script' };
            }

            return symbol;
        });

        function collectSymbols(
            tree: NavigationTree,
            container: string | undefined,
            cb: (symbol: SymbolInformation) => void,
        ) {
            const start = tree.spans[0];
            const end = tree.spans[tree.spans.length - 1];
            if (start && end) {
                cb(
                    SymbolInformation.create(
                        tree.text,
                        symbolKindFromString(tree.kind),
                        Range.create(
                            document.positionAt(start.start),
                            document.positionAt(end.start + end.length),
                        ),
                        document.getURL(),
                        container,
                    ),
                );
            }
            if (tree.childItems) {
                for (const child of tree.childItems) {
                    collectSymbols(child, tree.text, cb);
                }
            }
        }
    }

    getCompletions(
        document: Document,
        position: Position,
        triggerCharacter?: string,
    ): CompletionItem[] {
        if (!this.host.getConfig<boolean>('typescript.completions.enable')) {
            return [];
        }

        const lang = getLanguageServiceForDocument(document, this.createDocument);
        const completions = lang.getCompletionsAtPosition(
            document.getFilePath()!,
            document.offsetAt(position),
            {
                includeCompletionsForModuleExports: true,
                triggerCharacter: triggerCharacter as any,
            },
        );
        console.log(completions);

        if (!completions) {
            return [];
        }

        return completions!.entries.map(comp => {
            return <CompletionItem>{
                label: comp.name,
                kind: scriptElementKindToCompletionItemKind(comp.kind),
                sortText: comp.sortText,
                commitCharacters: getCommitCharactersForScriptElement(comp.kind),
                preselect: comp.isRecommended,
            };
        });
    }
}
