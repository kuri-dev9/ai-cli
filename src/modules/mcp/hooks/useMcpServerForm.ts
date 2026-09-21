import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import { MCP_SUPPORTED_SCOPES, MCP_SUPPORTED_TRANSPORTS } from '@/shared/constants';
import type {
  McpConnectionTestResult,
  McpFormState,
  McpProject,
  McpProvider,
  McpScope,
  McpTransport,
  ProviderMcpServer,
} from '@/shared/types';
import {
  formatKeyValueLines,
  getErrorMessage,
  getProjectPath,
  isMcpTransport,
  mergeApiKeyHeader,
  parseKeyValueLines,
  parseListLines,
  readApiKeyHeader,
} from '@/modules/mcp/utils/mcpFormatting';

type UseMcpServerFormArgs = {
  provider: McpProvider;
  editingServer: ProviderMcpServer | null;
  currentProjects: McpProject[];
  supportedScopes?: McpScope[];
  supportedTransports?: McpTransport[];
  unsupportedTransportMessage?: (transport: McpTransport) => string;
  onSubmit: (formData: McpFormState, editingServer: ProviderMcpServer | null) => Promise<void>;
};

type McpConnectionTestApiResponse =
  | { success: true; data: { provider: McpProvider; result: McpConnectionTestResult } }
  | { success: false; error?: { code?: string; message?: string } };

type MultilineFieldText = {
  args: string;
  env: string;
  headers: string;
  envVars: string;
  envHttpHeaders: string;
};

const DEFAULT_MCP_FORM: McpFormState = {
  name: '',
  scope: 'user',
  workspacePath: '',
  transport: 'stdio',
  command: '',
  args: [],
  env: {},
  cwd: '',
  url: '',
  headers: {},
  apiKey: '',
  envVars: [],
  bearerTokenEnvVar: '',
  envHttpHeaders: {},
  importMode: 'form',
  jsonInput: '',
};

const cloneDefaultForm = (
  provider: McpProvider,
  supportedScopes = MCP_SUPPORTED_SCOPES[provider],
  supportedTransports = MCP_SUPPORTED_TRANSPORTS[provider],
): McpFormState => ({
  ...DEFAULT_MCP_FORM,
  scope: supportedScopes[0],
  transport: supportedTransports[0],
  args: [],
  env: {},
  headers: {},
  envVars: [],
  envHttpHeaders: {},
});

const createFormStateFromServer = (
  provider: McpProvider,
  server: ProviderMcpServer,
  supportedScopes?: McpScope[],
  supportedTransports?: McpTransport[],
): McpFormState => {
  // A server whose only header is an API key loads into the simple field, so
  // reopening it shows the same one-line form it was created from. Anything
  // else stays in the advanced textarea untouched, which is what keeps
  // Authorization/Bearer servers editable.
  const savedApiKey = readApiKeyHeader(server.headers);

  return {
    ...cloneDefaultForm(provider, supportedScopes, supportedTransports),
    name: server.name,
    scope: server.scope,
    workspacePath: server.workspacePath || '',
    transport: server.transport,
    command: server.command || '',
    args: server.args || [],
    env: server.env || {},
    cwd: server.cwd || '',
    url: server.url || '',
    headers: savedApiKey === undefined ? server.headers || {} : {},
    apiKey: savedApiKey ?? '',
    envVars: server.envVars || [],
    bearerTokenEnvVar: server.bearerTokenEnvVar || '',
    envHttpHeaders: server.envHttpHeaders || {},
  };
};

/** Whether a loaded server carries anything the collapsed form would hide, in which case the advanced section opens with it. */
const hasAdvancedValues = (formData: McpFormState): boolean => (
  Object.keys(formData.headers).length > 0
  || Object.keys(formData.env).length > 0
  || formData.envVars.length > 0
  || Boolean(formData.bearerTokenEnvVar)
  || Object.keys(formData.envHttpHeaders).length > 0
);

const createMultilineTextFromForm = (formData: McpFormState): MultilineFieldText => ({
  args: formData.args.join('\n'),
  env: formatKeyValueLines(formData.env),
  headers: formatKeyValueLines(formData.headers),
  envVars: formData.envVars.join('\n'),
  envHttpHeaders: formatKeyValueLines(formData.envHttpHeaders),
});

const normalizeScope = (supportedScopes: McpScope[], value: McpScope): McpScope => (
  supportedScopes.includes(value) ? value : supportedScopes[0]
);

const normalizeTransport = (supportedTransports: McpTransport[], value: McpTransport): McpTransport => (
  supportedTransports.includes(value) ? value : supportedTransports[0]
);

export function useMcpServerForm({
  provider,
  editingServer,
  currentProjects,
  supportedScopes = MCP_SUPPORTED_SCOPES[provider],
  supportedTransports = MCP_SUPPORTED_TRANSPORTS[provider],
  unsupportedTransportMessage,
  onSubmit,
}: UseMcpServerFormArgs) {
  const { t } = useTranslation('settings');
  const [formData, setFormData] = useState<McpFormState>(() => (
    cloneDefaultForm(provider, supportedScopes, supportedTransports)
  ));
  const [multilineText, setMultilineText] = useState<MultilineFieldText>(() => (
    createMultilineTextFromForm(cloneDefaultForm(provider, supportedScopes, supportedTransports))
  ));
  const [jsonValidationError, setJsonValidationError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [connectionTest, setConnectionTest] = useState<McpConnectionTestResult | null>(null);

  const isEditing = Boolean(editingServer);

  // The modal is mounted only while open, so this runs on mount and whenever the
  // edit target changes. The state initializers above already produce the blank
  // form; this exists to load an existing server into it.
  useEffect(() => {
    setJsonValidationError('');
    setConnectionTest(null);
    if (editingServer) {
      const nextFormData = createFormStateFromServer(provider, editingServer, supportedScopes, supportedTransports);
      setFormData(nextFormData);
      setMultilineText(createMultilineTextFromForm(nextFormData));
      setShowAdvanced(hasAdvancedValues(nextFormData));
      return;
    }

    const nextFormData = cloneDefaultForm(provider, supportedScopes, supportedTransports);
    setFormData(nextFormData);
    setMultilineText(createMultilineTextFromForm(nextFormData));
    setShowAdvanced(false);
  }, [editingServer, provider, supportedScopes, supportedTransports]);

  const projectOptions = useMemo(() => (
    currentProjects
      .map((project) => ({
        value: getProjectPath(project),
        // Fall back to projectId (DB primary key) when no display name is set.
        label: project.displayName || project.projectId,
      }))
      .filter((project) => project.value)
  ), [currentProjects]);

  // A handshake result only describes the values it was run against, so any
  // edit retires it rather than leaving a green "connected" line above a URL
  // or key the user has since changed.
  const updateForm = <K extends keyof McpFormState>(key: K, value: McpFormState[K]) => {
    setConnectionTest(null);
    setFormData((prev) => ({ ...prev, [key]: value }));
  };

  const updateScope = (scope: McpScope) => {
    setFormData((prev) => ({
      ...prev,
      scope: normalizeScope(supportedScopes, scope),
      workspacePath: scope === 'user' ? '' : prev.workspacePath,
    }));
  };

  const updateTransport = (transport: McpTransport) => {
    setConnectionTest(null);
    setFormData((prev) => ({ ...prev, transport: normalizeTransport(supportedTransports, transport) }));
  };

  const validateJsonInput = (value: string) => {
    if (!value.trim()) {
      setJsonValidationError('');
      return;
    }

    try {
      const parsed = JSON.parse(value) as { type?: unknown; transport?: unknown; command?: unknown; url?: unknown };
      const transportInput = parsed.transport || parsed.type;
      if (!isMcpTransport(transportInput)) {
        setJsonValidationError(t('mcpForm.validation.missingType'));
      } else if (!supportedTransports.includes(transportInput)) {
        setJsonValidationError(
          unsupportedTransportMessage?.(transportInput) ?? `${provider} does not support ${transportInput} MCP servers`,
        );
      } else if (transportInput === 'stdio' && !parsed.command) {
        setJsonValidationError(t('mcpForm.validation.stdioRequiresCommand'));
      } else if ((transportInput === 'http' || transportInput === 'sse') && !parsed.url) {
        setJsonValidationError(t('mcpForm.validation.httpRequiresUrl', { type: transportInput }));
      } else {
        setJsonValidationError('');
      }
    } catch {
      setJsonValidationError(t('mcpForm.validation.invalidJson'));
    }
  };

  const updateJsonInput = (value: string) => {
    setFormData((prev) => ({ ...prev, jsonInput: value }));
    validateJsonInput(value);
  };

  const updateMultilineText = <K extends keyof MultilineFieldText>(key: K, value: MultilineFieldText[K]) => {
    setConnectionTest(null);
    setMultilineText((prev) => ({ ...prev, [key]: value }));
  };

  const createSubmitFormData = (): McpFormState => ({
    ...formData,
    args: parseListLines(multilineText.args),
    env: parseKeyValueLines(multilineText.env),
    headers: parseKeyValueLines(multilineText.headers),
    envVars: parseListLines(multilineText.envVars),
    envHttpHeaders: parseKeyValueLines(multilineText.envHttpHeaders),
  });

  // stdio is out of scope: testing it would mean spawning the user's command
  // from the server, so the modal hides the button rather than offering a test
  // that cannot run.
  const canTestConnection = formData.importMode === 'form'
    && formData.transport !== 'stdio'
    && Boolean(formData.url.trim());

  /**
   * Asks the server to run an `initialize` handshake with exactly the values
   * the form would save, including the merged API key header, so a green result
   * means the saved config connects rather than that the host merely answered.
   */
  const testConnection = async () => {
    if (!canTestConnection) {
      return;
    }

    setIsTestingConnection(true);
    setConnectionTest(null);
    try {
      const submitFormData = createSubmitFormData();
      const response = await api.providers.testMcpServer(provider, {
        transport: submitFormData.transport,
        url: submitFormData.url.trim(),
        headers: mergeApiKeyHeader(submitFormData.headers, submitFormData.apiKey),
      });
      const payload = await response.json() as McpConnectionTestApiResponse;

      if (!response.ok || !payload.success) {
        setConnectionTest({
          ok: false,
          reason: 'protocolError',
          detail: payload.success === false ? payload.error?.message : undefined,
        });
        return;
      }

      setConnectionTest(payload.data.result);
    } catch (error) {
      setConnectionTest({ ok: false, reason: 'unreachable', detail: getErrorMessage(error) });
    } finally {
      setIsTestingConnection(false);
    }
  };

  const canSubmit = useMemo(() => {
    if (!formData.name.trim()) {
      return false;
    }

    if (formData.scope !== 'user' && !formData.workspacePath.trim()) {
      return false;
    }

    if (formData.importMode === 'json') {
      return Boolean(formData.jsonInput.trim()) && !jsonValidationError;
    }

    if (formData.transport === 'stdio') {
      return Boolean(formData.command.trim());
    }

    return Boolean(formData.url.trim());
  }, [formData, jsonValidationError]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);

    try {
      // Textareas keep raw strings while editing so users can create blank
      // lines or partial KEY=value entries without the form rewriting them.
      await onSubmit(createSubmitFormData(), editingServer);
    } catch (error) {
      alert(`Error: ${getErrorMessage(error)}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return {
    formData,
    multilineText,
    projectOptions,
    isEditing,
    isSubmitting,
    jsonValidationError,
    canSubmit,
    showAdvanced,
    setShowAdvanced,
    canTestConnection,
    isTestingConnection,
    connectionTest,
    testConnection,
    updateForm,
    updateScope,
    updateTransport,
    updateJsonInput,
    updateMultilineText,
    handleSubmit,
  };
}
