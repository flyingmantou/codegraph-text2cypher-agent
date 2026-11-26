#!/bin/zsh
unsetopt XTRACE VERBOSE
set -eu
cd -- "${0:A:h:h}"
task_node="$(command -v node || true)"
if [[ -z "$task_node" && -x /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node ]]; then
 task_node=/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
fi
if [[ -z "$task_node" ]]; then
 print '请先安装 Node.js 24.22.3 或更新版本。'
 exit 1
fi
trap 'unset DEEPSEEK_API_KEY GLM_API_KEY' EXIT
print '真实模型 API 测试，使用人工图谱，最多 16 次请求。密钥隐藏输入且不落盘。'
read -r -s 'DEEPSEEK_API_KEY?DeepSeek API Key: '
print ''
read -r -s 'GLM_API_KEY?GLM API Key: '
print ''
export DEEPSEEK_API_KEY GLM_API_KEY
task_exit=0
"$task_node" scripts/test-live.ts || task_exit=$?
unset DEEPSEEK_API_KEY GLM_API_KEY
exit "$task_exit"
