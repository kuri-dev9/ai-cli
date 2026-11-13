export { default as EditorSidebar } from '@/modules/code-editor/EditorSidebar';
// 워크스페이스의 오른쪽 파일·소스 관리 패널이 그 안에서 파일을 열 때 쓴다.
export { default as CodeEditor } from '@/modules/code-editor/CodeEditor';
export { useEditorSidebar } from '@/modules/code-editor/hooks/useEditorSidebar';
export { default as MarkdownPreview } from '@/modules/code-editor/markdown/MarkdownPreview';
export { default as MermaidDiagram } from '@/modules/code-editor/markdown/MermaidDiagram';
export { getPreviewKind, isViewableFile } from '@/modules/code-editor/utils/previewableFile';
