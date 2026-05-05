# 04. Prompt Contract

> runner（Claude / Codex 子プロセス）と workflow を結ぶインターフェース定義。自由テキストを返させない仕組み。

## 動機

LLM の自由出力を実装側が文字列パースで解釈すると:

- 「成功した気になって failed を見逃す」
- 「`completed` だが何も書いていない」
- 「`need_input` の質問が無いまま停止」

を検出できない。**runner の出力を構造化 + schema 検証** で機械的に拒否することで、上記事故を **未然に paused へ落とす**。

## 入出力型

`packages/core/src/runner-contract.ts`:

```mermaid
flowchart LR
  subgraph in["AgentRunInput"]
    in1[provider]
    in2[phase]
    in3[promptContract]
    in4[model]
    in5[permissions<br/>auto/readonly/workspace-write]
    in6[timeoutMs]
    in7[prompt]
    in8[resume?<br/>session ids]
    in9[questionResponse?]
  end

  subgraph runner["runClaude / runCodex"]
    spawn[child spawn]
    parse[parse YAML stdout]
    validate[validatePromptContractPayload]
  end

  subgraph out["AgentRunOutput"]
    o1[status:<br/>completed/need_input/<br/>paused/rate_limited/failed]
    o2[summary]
    o3[structured?<br/>contract data]
    o4[question?]
    o5[session?]
    o6[resolvedModel?]
  end

  in --> runner --> out
```

`AgentRunStatus` の取り得る値:

```
completed | need_input | paused | rate_limited | failed
```

`rate_limited` は runner 側で挿入する集約状態。prompt-contract（LLM 出力 YAML）には現れない。

## 検証フロー

```mermaid
flowchart TB
  Stdout["子プロセス stdout"]
  Stdout --> ParseY["parsePromptContractYaml<br/>(yaml.parseDocument)"]
  ParseY -- syntax error --> Fail1["payload reject<br/>→ failed"]
  ParseY -- ok --> Obj["JS object"]
  Obj --> Vali["validatePromptContractPayload"]
  Vali -- errors --> Fail2["status=failed<br/>summary=<violation>"]
  Vali -- ok --> Sw{status?}
  Sw -- completed --> ReqData["data 必須<br/>question 禁止"]
  Sw -- need_input --> ReqQ["question 必須<br/>data 任意"]
  Sw -- paused/failed --> NoQ["question 禁止<br/>data 任意"]
  ReqData --> Done([Workflow へ])
  ReqQ --> Done
  NoQ --> Done
```

contract ごとに `data` フィールドのスキーマが異なる（`promptContractJsonSchema(contract)`）。代表:

| contract | `data` の主要フィールド |
|----------|----------------------|
| `plan` | plan 内容（Markdown を含む構造） |
| `plan-verify` | findings: `PlanVerifyFinding[]` |
| `plan-fix` | 修正内容 |
| `implement` | commit 情報 / 変更ファイル等 |
| `review` | findings: `ReviewFinding[]` |
| `supervise` | findings の取捨判定 |
| `fix` | 適用した変更 |

正典スキーマは `runner-contract.ts: dataJsonSchemaFor(contract)` および SPEC §4.5 / §4.6。

## 共通制約

- payload は **オブジェクト**。配列やスカラーは reject
- 未知キーは reject（`rejectUnknownKeys`）
- `summary` は最大 16 KiB
- `question.text` / `question.default` も最大 16 KiB
- `status` 列挙外は reject
- 各 status × 各 contract の組合せで `data` 形が決まる

## need_input の往復

```mermaid
sequenceDiagram
  participant R as runner
  participant WF as workflow
  participant T as TUI / -y
  participant R2 as runner (resume)

  R->>WF: status=need_input,<br/>question={text, default}
  WF->>WF: persist paused<br/>(failure_code=need_input_pending)
  WF-->>T: 質問提示
  T->>WF: 回答
  WF->>R2: AgentRunInput<br/>(questionResponse=<answer>,<br/>resume=<sessionId>)
  R2->>R2: formatQuestionResponsePrompt<br/>(JSON envelope を prompt に挿入)
  R2-->>WF: status=completed (期待)
```

answer は `autokit_need_input_response` という JSON envelope に包まれて prompt に挿入される（`formatQuestionResponsePrompt`）。runner 側の prompt-contract 仕様書（`.agents/prompts/*.md`）でこの envelope を読み取り次の出力を返す約束になっている。

`-y` 経路は `cli/index.ts: createNeedInputAutoAnswer` が question.default を answer として返す。default が空なら **無理に進めず** paused のまま log に warn を残す。

## prompt-contract が解く問題

| 起こりうる runner 事故 | contract 検証で起きること |
|----------------------|-------------------------|
| 出力が markdown のみ | yaml parse 失敗 → failed |
| `status: success` | enum 違反 → failed |
| `completed` と書きつつ `data` なし | required violation → failed |
| `completed` で `question` も付ける | mutual exclusion violation → failed |
| `need_input` で question.text が空 | bounded string violation → failed |
| 回答済みなのに同じ質問を繰返 | session resume + envelope で一度きり |

**reject すれば paused に落ちて人手判断に委ねられる**。これが「自由テキスト解釈」より優れている理由。

## 関連

- 各 phase の prompt 本文: `.agents/prompts/<phase>.md` (init で配布)
- contract 検証実装: `packages/core/src/runner-contract.ts`
- contract data の正典: SPEC §4.5 / §4.6
