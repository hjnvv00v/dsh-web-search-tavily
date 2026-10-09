/**
 * Browser half of the Tavily-compatible search provider: the configuration card on the Plugins
 * page.
 *
 * The card binds the Host loader entry's settings namespace through `ctx.configForms` and keeps
 * its staged draft in the shared `SettingsFormModel` of `ui-primitives`, so it saves through the
 * same conflict-checked path every other configuration page uses. The API key is the one control
 * that does not live in the section: its literal never rides a response, so the page learns only
 * whether one is configured and writes it through the credentials domain under the reference the
 * section names.
 *
 * It registers into two keyed slots of the Plugins page — the bundle's own page and the row's
 * Configure page — so the form is reachable from both places the page offers.
 *
 * @module dsh-web-search-tavily-relay/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-web-search-tavily-relay',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const { jsx, jsxs } = require('react/jsx-runtime')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    /**
     * Settings namespace this card edits. A Host entry's namespace is its loader entry id, which
     * the bundle patch declares as `web-search-tavily`.
     */
    const NAMESPACE = 'web-search-tavily'
    /** Bundle package name; the key `plugins.bundle.config` registers under. */
    const BUNDLE = 'dsh-web-search-tavily-relay'
    /** Row id the bundle patch declares; the key `plugins.row.config` registers under. */
    const ROW = 'web-search-tavily'
    /** Credential reference the provider resolves when the section names none. */
    const DEFAULT_API_KEY_REF = 'TAVILY_API_KEY'
    /** Form field the credential control stages under. */
    const API_KEY_FIELD = 'apiKey'
    /** Dictionary namespace owned by this plugin. */
    const NS = 'webSearchTavily'

    /** English copy. */
    const en = {
      description: 'Search the web through Tavily or any Tavily- or OpenAI-compatible endpoint.',
      groupConnection: 'Connection',
      protocol: 'Protocol',
      protocolHint: 'How requests are shaped. Use "tavily" for Tavily and relays that mirror it, '
        + '"openai-responses" for an OpenAI-compatible /v1/responses gateway, "openai-chat" for /v1/chat/completions.',
      baseURL: 'Endpoint',
      baseURLHint: 'Base URL or full endpoint. Empty uses the protocol default '
        + '(https://api.tavily.com or https://api.openai.com/v1). A relay domain goes here.',
      model: 'Model',
      modelHint: 'Used by the OpenAI-compatible protocols only.',
      groupAuth: 'Authentication',
      apiKey: 'API key',
      apiKeyHint: 'Stored outside the settings file. Leave blank to keep the current key.',
      apiKeySet: 'A key is configured.',
      apiKeyUnset: 'No key is configured.',
      apiKeyEnv: 'Credential name',
      apiKeyEnvHint: 'The reference the key is stored and resolved under.',
      authStyle: 'Auth style',
      authStyleHint: 'auto sends a bearer header and, for Tavily, the key in the body too.',
      authHeader: 'Header name',
      authHeaderHint: 'Used only when the auth style is "header".',
      authScheme: 'Scheme prefix',
      authSchemeHint: 'Placed before the key; leave empty to send the key bare.',
      groupSearch: 'Search',
      searchDepth: 'Search depth',
      searchDepthHint: 'Tavily only: basic, advanced, fast, or ultra-fast.',
      topic: 'Topic',
      topicHint: 'Tavily only: general or news.',
      maxResults: 'Max results',
      maxResultsHint: 'Upper bound requested from the provider.',
      includeAnswer: 'Include answer',
      includeAnswerHint: 'Ask Tavily for a synthesized answer and surface it as the result content.',
      timeoutMs: 'Timeout (ms)',
      timeoutMsHint: 'How long one search may take before it fails.',
      defaultParameters: 'Extra request fields (JSON)',
      defaultParametersHint: 'Merged into the request last, so it reaches any parameter without a '
        + 'field above — for example {"time_range":"week","country":"China","exact_match":true}. '
        + 'Tavily\'s own parameter names apply; the query itself cannot be overridden.',
      yes: 'Yes',
      no: 'No',
      overridden: 'Overridden',
      reset: 'Reset to default',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      invalidNumber: 'Enter a number, or leave blank to use the default.',
    }

    /** Simplified Chinese copy. */
    const zh = {
      description: '通过 Tavily 或任意兼容 Tavily / OpenAI 格式的中转接口搜索网页。',
      groupConnection: '连接',
      protocol: '协议',
      protocolHint: '请求的报文格式。官方 Tavily 或同格式中转选 tavily；OpenAI 兼容的 /v1/responses '
        + '网关选 openai-responses；/v1/chat/completions 选 openai-chat。',
      baseURL: '接口地址',
      baseURLHint: '填域名前缀或完整接口地址；留空使用协议默认值（https://api.tavily.com 或 '
        + 'https://api.openai.com/v1）。中转域名填这里。',
      model: '模型',
      modelHint: '仅 OpenAI 兼容的两种协议使用。',
      groupAuth: '认证',
      apiKey: 'API Key',
      apiKeyHint: '不写入设置文件。留空表示保持当前密钥。',
      apiKeySet: '已配置密钥。',
      apiKeyUnset: '未配置密钥。',
      apiKeyEnv: '密钥变量名',
      apiKeyEnvHint: '密钥保存和读取时使用的引用名。',
      authStyle: '认证方式',
      authStyleHint: 'auto 会带 Bearer 头；tavily 协议下同时把 key 放进请求体。',
      authHeader: '请求头名称',
      authHeaderHint: '仅认证方式为 header 时使用。',
      authScheme: '前缀',
      authSchemeHint: '放在密钥前面；留空表示直接发送密钥本身。',
      groupSearch: '搜索参数',
      searchDepth: '搜索深度',
      searchDepthHint: '仅 Tavily：basic / advanced / fast / ultra-fast。',
      topic: '主题',
      topicHint: '仅 Tavily：general 或 news。',
      maxResults: '最大结果数',
      maxResultsHint: '向提供方请求的结果数量上限。',
      includeAnswer: '返回摘要答案',
      includeAnswerHint: '让 Tavily 额外生成一段答案，作为搜索结果的内容返回。',
      timeoutMs: '超时（毫秒）',
      timeoutMsHint: '单次搜索的最长等待时间，超时即失败。',
      defaultParameters: '附加请求字段（JSON）',
      defaultParametersHint: '最后合并进请求体，用来设置上面没有单独字段的参数——例如 '
        + '{"time_range":"week","country":"China","exact_match":true}。字段名用 Tavily 官方的；'
        + 'query 本身不允许覆盖。',
      yes: '是',
      no: '否',
      overridden: '已覆盖',
      reset: '恢复默认',
      readOnly: '本部署的设置为只读。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      save: '保存',
      saving: '保存中…',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      invalidNumber: '请填数字；留空表示使用默认值。',
    }

    /** Protocol choices, in the order the wire formats are most commonly deployed. */
    const PROTOCOL_OPTIONS = [
      { value: 'tavily', label: 'Tavily' },
      { value: 'openai-responses', label: 'OpenAI Responses' },
      { value: 'openai-chat', label: 'OpenAI Chat' },
    ]

    /** Auth styles, with the short labels the segmented control needs. */
    const AUTH_OPTIONS = [
      { value: 'auto', label: 'Auto' },
      { value: 'bearer', label: 'Bearer' },
      { value: 'body', label: 'Body' },
      { value: 'header', label: 'Header' },
      { value: 'none', label: 'None' },
    ]

    /** Boolean switch choices, spelled as the string the section stores. */
    const booleanOptions = (t) => [
      { value: 'false', label: t('no') },
      { value: 'true', label: t('yes') },
    ]

    /** The form frame's copy, read from this page's dictionary. */
    function formLabels(t) {
      return {
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      }
    }

    /** A group heading inside the card. */
    function Group({ children }) {
      return jsx('h4', {
        style: {
          margin: '18px 0 0',
          fontSize: '13px',
          fontWeight: 600,
          lineHeight: '20px',
          color: 'var(--dsw-alias-label-primary)',
        },
        children,
      })
    }

    /**
     * One segmented choice over a section field.
     *
     * The control stages through the shared form rather than owning a draft, so Save, Discard, and
     * the conflict check behave exactly like every text control beside it.
     */
    function ChoiceField({ id, label, hint, value, options, disabled, overridden, onEdit, onReset, resetLabel, overriddenLabel }) {
      return jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '6px' },
        children: [
          jsxs('div', {
            style: { display: 'flex', alignItems: 'center', gap: '8px' },
            children: [
              jsx('label', {
                htmlFor: id,
                style: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' },
                children: label,
              }),
              overridden
                ? jsx('button', {
                  type: 'button',
                  disabled,
                  onClick: onReset,
                  style: {
                    border: 0,
                    background: 'none',
                    padding: 0,
                    cursor: disabled ? 'default' : 'pointer',
                    fontSize: '12px',
                    color: 'var(--dsw-alias-brand-primary)',
                  },
                  children: resetLabel,
                })
                : null,
            ],
          }),
          jsx(primitives.SegmentedControl, {
            id,
            value,
            options,
            label,
            disabled,
            onChange: onEdit,
          }),
          hint === undefined ? null : jsx('p', {
            style: { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
            children: hint,
          }),
          overridden && overriddenLabel !== undefined
            ? jsx('span', {
              style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
              children: overriddenLabel,
            })
            : null,
        ],
      })
    }

    /**
     * The configuration card.
     *
     * @param props - the view asked for, the page's locale reader, the form snapshot, and its actions.
     * @returns the one-liner, or the form.
     */
    function TavilyCard(props) {
      const { t } = props
      const state = props.useTavilySearchCard((snapshot) => snapshot)
      if (props.view === 'summary') return t('description')
      const disabled = !state.writable
      const choice = (field, label, hint, options) => jsx(ChoiceField, {
        id: `plugin-config-tavily-${field}`,
        label,
        hint,
        value: state[field].text,
        options,
        disabled,
        overridden: state[field].overridden,
        onEdit: (value) => {
          props.edit(field, value)
        },
        onReset: () => {
          props.resetField(field)
        },
        resetLabel: t('reset'),
        overriddenLabel: t('overridden'),
      }, field)
      const value = (field, label, hint, numeric = false) => jsx(primitives.SettingsValueField, {
        id: `plugin-config-tavily-${field}`,
        label,
        hint,
        overriddenLabel: t('overridden'),
        resetLabel: t('reset'),
        invalidLabel: t('invalidNumber'),
        numeric,
        disabled,
        ...state[field],
        onEdit: (text) => {
          props.edit(field, text)
        },
        onReset: () => {
          props.resetField(field)
        },
      }, field)
      return jsxs(primitives.SettingsForm, {
        labels: formLabels(t),
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children: [
          jsx(Group, { children: t('groupConnection') }, 'g1'),
          choice('protocol', t('protocol'), t('protocolHint'), PROTOCOL_OPTIONS),
          value('baseURL', t('baseURL'), t('baseURLHint')),
          value('model', t('model'), t('modelHint')),

          jsx(Group, { children: t('groupAuth') }, 'g2'),
          jsx(primitives.SettingsSecretField, {
            id: 'plugin-config-tavily-key',
            label: t('apiKey'),
            hint: t('apiKeyHint'),
            disabled: !state.apiKeyWritable,
            text: state.apiKey.text,
            configured: state.apiKeyConfigured,
            stateLabel: state.apiKeyConfigured ? t('apiKeySet') : t('apiKeyUnset'),
            onEdit: (text) => {
              props.edit(API_KEY_FIELD, text)
            },
          }, 'secret'),
          value('apiKeyEnv', t('apiKeyEnv'), t('apiKeyEnvHint')),
          choice('authStyle', t('authStyle'), t('authStyleHint'), AUTH_OPTIONS),
          value('authHeader', t('authHeader'), t('authHeaderHint')),
          value('authScheme', t('authScheme'), t('authSchemeHint')),

          jsx(Group, { children: t('groupSearch') }, 'g3'),
          value('searchDepth', t('searchDepth'), t('searchDepthHint')),
          value('topic', t('topic'), t('topicHint')),
          value('maxResults', t('maxResults'), t('maxResultsHint'), true),
          choice('includeAnswer', t('includeAnswer'), t('includeAnswerHint'), booleanOptions(t)),
          value('timeoutMs', t('timeoutMs'), t('timeoutMsHint'), true),
          value('defaultParameters', t('defaultParameters'), t('defaultParametersHint')),
        ],
      })
    }

    /**
     * Bridges the loader entry's settings scope and the credentials domain onto the card.
     *
     * The key is staged with the rest of the form so one save covers everything the card shows,
     * but it is written through the credentials domain rather than into the section, because the
     * Host never sends a secret literal back.
     */
    class TavilyCardController {
      /**
       * @param scope - the bound settings scope for this entry's namespace.
       * @param ctx - the page plugin's context, whose `remote.credentials` namespace answers.
       */
      constructor(scope, ctx) {
        this.scope = scope
        this.ctx = ctx
        this.credential = { ref: '', configured: false, writable: true }
        this.form = new primitives.SettingsFormModel(scope, [
          primitives.settingsTextField('protocol'),
          primitives.settingsTextField('baseURL'),
          primitives.settingsTextField('model'),
          primitives.settingsTextField('authStyle'),
          primitives.settingsTextField('authHeader'),
          primitives.settingsTextField('authScheme'),
          primitives.settingsTextField('apiKeyEnv'),
          primitives.settingsTextField('searchDepth'),
          primitives.settingsTextField('topic'),
          primitives.settingsTextField('includeAnswer'),
          primitives.settingsTextField('defaultParameters'),
          primitives.settingsNumberField('maxResults'),
          primitives.settingsNumberField('timeoutMs'),
        ], [{
          field: API_KEY_FIELD,
          write: (text) => this.writeKey(text),
        }])
        this.store = this.form.bind(() => this.projection())
        this.unsubscribe = scope.subscribe(() => {
          this.readCredential()
        })
        this.readCredential()
      }

      /** Build the card's state from the shared form's current reads. */
      projection() {
        return {
          ...this.form.shell(),
          protocol: this.form.field('protocol'),
          baseURL: this.form.field('baseURL'),
          model: this.form.field('model'),
          authStyle: this.form.field('authStyle'),
          authHeader: this.form.field('authHeader'),
          authScheme: this.form.field('authScheme'),
          apiKeyEnv: this.form.field('apiKeyEnv'),
          searchDepth: this.form.field('searchDepth'),
          topic: this.form.field('topic'),
          includeAnswer: this.form.field('includeAnswer'),
          defaultParameters: this.form.field('defaultParameters'),
          maxResults: this.form.field('maxResults'),
          timeoutMs: this.form.field('timeoutMs'),
          apiKey: this.form.field(API_KEY_FIELD),
          apiKeyConfigured: this.credential.configured,
          apiKeyWritable: this.credential.writable,
        }
      }

      /**
       * Ask the credentials domain about the reference the section currently names.
       *
       * The answer is stored with the reference it describes: `apiKeyEnv` can change between the
       * request and its response, and two reads can settle out of order, so a response is
       * published only while it still answers for the reference in force.
       */
      async readCredential() {
        const ref = refOf(this.scope.getSnapshot())
        if (ref !== this.credential.ref) {
          this.credential = { ref, configured: false, writable: true }
          this.store.set(this.projection())
        }
        const response = await this.ctx.remote.credentials.describe([ref])
        if (!response.ok || ref !== refOf(this.scope.getSnapshot())) return
        const view = response.value[ref]
        const next = {
          ref,
          configured: view?.configured ?? false,
          writable: view?.writable ?? true,
        }
        if (next.configured === this.credential.configured && next.writable === this.credential.writable) return
        this.credential = next
        this.store.set(this.projection())
      }

      /**
       * Re-read after the Host reports a change to the reference this card watches.
       *
       * @param ref - the reference the Host reports as changed.
       */
      refreshCredential(ref) {
        if (ref !== this.credential.ref) return
        this.readCredential()
      }

      /** Build the face the page's slot registration injects. */
      inject() {
        return {
          hooks: { tavilySearchCard: this.store },
          ...this.form.actions(),
        }
      }

      /**
       * Write the staged key, then re-read whether the Host now holds one.
       *
       * @param value - the staged credential literal.
       * @returns whether the Host reports a configured credential afterwards.
       */
      async writeKey(value) {
        await this.ctx.remote.credentials.set(refOf(this.scope.getSnapshot()), value)
        await this.readCredential()
        return this.credential.configured
      }

      /** Release configuration subscriptions. */
      dispose() {
        this.unsubscribe()
        this.form.dispose()
      }
    }

    /**
     * The credential reference the section names, or the provider's default.
     *
     * @param snapshot - the current scope snapshot.
     * @returns the reference to address.
     */
    function refOf(snapshot) {
      const declared = snapshot.value?.apiKeyEnv
      return declared !== undefined && declared.length > 0 ? declared : DEFAULT_API_KEY_REF
    }

    /** Required services (cordis fiber inject). */
    const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms']

    /**
     * Mount the configuration card while the Host serves this plugin's settings namespace.
     *
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'web-search-tavily: dictionaries')
      const card = new TavilyCardController(ctx.configForms.get(NAMESPACE), ctx)
      ctx.effect(() => () => {
        card.dispose()
      }, 'web-search-tavily: form subscription')
      ctx.effect(() => ctx.remote.$on('credentials/reference-updated', (ref) => {
        card.refreshCredential(ref)
      }), 'web-search-tavily: credential invalidations')
      // The bundle's own page and the row's Configure page: the page declares both slots, and a
      // registration lives only while the Host serves the namespace it edits.
      ctx.effect(() => ctx.configForms.whileServed([NAMESPACE], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: BUNDLE,
        order: 40,
        locale: NS,
        inject: () => card.inject(),
      }, TavilyCard))), 'web-search-tavily: bundle page')
      ctx.effect(() => ctx.configForms.whileServed([NAMESPACE], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: `${BUNDLE}#${ROW}`,
        order: 40,
        locale: NS,
        inject: () => card.inject(),
      }, TavilyCard))), 'web-search-tavily: row page')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
