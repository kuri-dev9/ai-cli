import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, ChevronRight } from "lucide-react";

import type { LLMProvider, ProviderModelOption } from "@/shared/types";
import { cn } from "@/shared/utils";
import { Badge, CommandGroup, CommandItem, LLMProviderLogo } from "@/shared/ui";

/**
 * One branch of the model picker.
 *
 * `provider` is what selecting a model in this branch sets, kept separate from
 * the branch itself so a branch does not have to be a provider.
 */
export type ModelGroup = {
  key: string;
  provider: LLMProvider;
  name: string;
  models: ProviderModelOption[];
};

type ModelGroupListProps = {
  groups: ModelGroup[];
  provider: LLMProvider;
  currentModel: string;
  loading: boolean;
  /** While searching, every branch is shown open — a hit inside a collapsed one would be invisible. */
  searching: boolean;
  onSelect: (provider: LLMProvider, model: string) => void;
  loadingLabel: string;
};

/**
 * Provider branches of the model picker, at most one open at a time.
 *
 * 열려 있는 branch 가 하나뿐이라, 다른 AI 를 찾으려고 목록을 한참 내리지 않아도
 * 된다. provider 가 네 개여도 접힌 줄은 네 줄이니 전체가 한눈에 들어온다.
 *
 * 처음 열었을 때 펼쳐 두는 곳은 "지금 쓰는 provider" 다. 대부분은 그 안에서
 * 모델만 바꾸므로 클릭이 한 번도 늘지 않고, 다른 AI 로 갈 때만 한 번 누른다.
 *
 * 접힘 상태를 저장소에 남기지 않는다. 이 목록은 다이얼로그가 닫힐 때 통째로
 * unmount 되므로, 다시 열면 언제나 "지금 쓰는 provider 가 펼쳐진" 상태에서
 * 시작한다 — 예전에 남겨 둔 접힘 상태가 지금 쓰는 provider 를 가리는 일이 없다.
 */
export default function ModelGroupList({
  groups,
  provider,
  currentModel,
  loading,
  searching,
  onSelect,
  loadingLabel,
}: ModelGroupListProps) {
  const { t } = useTranslation("chat");

  const defaultKey = useMemo(
    () => groups.find((group) => group.provider === provider)?.key ?? null,
    [groups, provider],
  );

  // `undefined` 는 "아직 아무것도 누르지 않음"(= defaultKey 를 편다) 이고,
  // `null` 은 "사용자가 전부 접었다" 다. 둘을 구분하지 않으면 펼쳐져 있던
  // branch 를 접자마자 기본값이 그것을 다시 펴 버린다.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const openKey = picked === undefined ? defaultKey : picked;

  // Branch 가 하나뿐이면 접을 이유가 없다. 설정에서 CLI 를 하나만 켜 둔 경우가
  // 그런데, 그때 접는 줄을 두면 모델을 보는 데 클릭만 한 번 더 든다.
  const collapsible = groups.length > 1;

  const toggle = useCallback((key: string) => {
    setPicked((previous) => {
      const current = previous === undefined ? defaultKey : previous;
      return current === key ? null : key;
    });
  }, [defaultKey]);

  return (
    <>
      {groups.map((group, index) => {
        // 검색 중에는 전부 편다. 접힌 branch 안의 결과는 보이지 않으니, 그대로
        // 두면 검색이 "지금 펼친 provider 안에서만" 찾는 기능이 되어 버린다.
        const isOpen = searching || !collapsible || openKey === group.key;
        const isEmpty = group.models.length === 0;
        const isLoadingGroup = isEmpty && loading;
        const showToggleRow = collapsible && !searching;
        const holdsCurrentModel = group.provider === provider
          && group.models.some((model) => model.value === currentModel);

        return (
          <CommandGroup
            key={group.key}
            className={cn(
              "[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider",
              index > 0 && "border-t border-border/40 [&_[cmdk-group-heading]]:mt-1",
            )}
            heading={showToggleRow ? undefined : (
              <span className="flex w-full items-center gap-1.5">
                <LLMProviderLogo provider={group.provider} className="h-3.5 w-3.5 shrink-0" />
                {group.name}
                {/*
                  검색 중에는 개수를 감춘다. 여기 적을 수 있는 숫자는 이 provider 가
                  가진 모델 전체 개수인데 그 아래에는 검색에 걸린 몇 개만 남으므로,
                  숫자와 눈에 보이는 줄 수가 어긋난다.
                */}
                {!searching && (
                  <span className="ml-auto text-[10px] font-normal normal-case tracking-normal text-muted-foreground">
                    {group.models.length}
                  </span>
                )}
              </span>
            )}
          >
            {/*
              접는 줄은 heading 이 아니라 목록의 한 줄(CommandItem)이다. heading 은
              안에 보이는 항목이 하나도 없으면 cmdk 가 통째로 감추므로, 접힌 branch
              에서는 클릭 대상이 같이 사라져 버린다. 줄로 두면 접혀 있어도 branch 가
              늘 한 줄을 차지하고, 키보드로도 펼 수 있다.
            */}
            {showToggleRow ? (
              <CommandItem
                value={`${group.name} ${group.provider}`}
                onSelect={() => toggle(group.key)}
                disabled={isEmpty && !loading}
                aria-expanded={isOpen}
                // `count` 가 아니라 `total` 로 넘긴다. i18next 는 `count` 를 보면
                // 복수형 키(`_one`/`_other`)를 먼저 찾는데, 여기 필요한 건 그냥
                // 숫자 하나뿐이라 로케일마다 복수형 키를 두는 값이 아니다.
                aria-label={t("providerSelection.providerModelCount", {
                  name: group.name,
                  total: group.models.length,
                  defaultValue: "{{name}}, {{total}} models",
                })}
                className="py-2 text-[13px] font-medium"
              >
                {isOpen ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <LLMProviderLogo provider={group.provider} className="h-4 w-4 shrink-0" />
                <span className="truncate">{group.name}</span>
                {holdsCurrentModel && !isOpen && (
                  <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                )}
                <span className="ml-auto shrink-0 text-[11px] font-normal text-muted-foreground">
                  {isLoadingGroup ? "…" : group.models.length}
                </span>
              </CommandItem>
            ) : null}

            {isOpen && isLoadingGroup ? (
              <CommandItem disabled className="ml-4 border-l border-border/40 pl-4 text-muted-foreground">
                {loadingLabel}
              </CommandItem>
            ) : null}

            {/*
              모델이 하나도 없는 provider. 접는 줄이 있을 때는 그 줄이 `0` 을 달고
              비활성으로 남아 "이 CLI 는 켜 뒀지만 쓸 모델이 없다" 를 그대로
              보여주므로 여기서 더 말할 것이 없다. 접는 줄이 없을 때만(= branch 가
              하나뿐) 말로 알린다. 검색 중이면 아무것도 그리지 않는다 — 검색어에
              걸리지 않은 provider 는 cmdk 가 감추는 편이 맞다.
            */}
            {isOpen && isEmpty && !loading && !searching && !showToggleRow ? (
              <CommandItem disabled className="ml-4 border-l border-border/40 pl-4 text-muted-foreground">
                {t("providerSelection.providerHasNoModels", {
                  defaultValue: "No models available",
                })}
              </CommandItem>
            ) : null}

            {isOpen && group.models.map((model) => {
              const isSelected = provider === group.provider && currentModel === model.value;

              return (
                <CommandItem
                  key={`${group.key}-${model.value}`}
                  value={`${group.name} ${model.label} ${model.description || ""}`}
                  onSelect={() => onSelect(group.provider, model.value)}
                  className="ml-4 border-l border-border/40 pl-4"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{model.label}</span>
                      {model.isCustom && (
                        <Badge className="h-4 shrink-0 rounded-full px-1.5 text-[8px]">Custom</Badge>
                      )}
                    </div>
                    {model.label !== model.value && (
                      <div className="truncate font-mono text-[10px] text-muted-foreground">
                        {model.value}
                      </div>
                    )}
                  </div>
                  {isSelected && <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />}
                </CommandItem>
              );
            })}
          </CommandGroup>
        );
      })}
    </>
  );
}
