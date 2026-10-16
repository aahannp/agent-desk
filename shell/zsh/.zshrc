# Agent Desk shell integration: load your own .zshrc, then mark where each command starts and ends,
# so Agent Desk can show commands as blocks. These are the OSC 133 marks VS Code and Warp use too.
ZDOTDIR=$_agent_desk_user_zdotdir
# /etc/zshrc picked the history file while ZDOTDIR still pointed here; keep history in your usual place.
[[ $HISTFILE == $_agent_desk_dir/* ]] && HISTFILE=$ZDOTDIR/.zsh_history
[[ -f $ZDOTDIR/.zshrc ]] && source $ZDOTDIR/.zshrc

_agent_desk_preexec() {
  print -rn -- $'\e]633;E;'"${1//[$'\a\e\n']/ }"$'\a\e]133;C\a'
}
_agent_desk_precmd() {
  local code=$?
  print -rn -- $'\e]133;D;'"$code"$'\a\e]133;A\a'
}
autoload -Uz add-zsh-hook
add-zsh-hook preexec _agent_desk_preexec
precmd_functions=(_agent_desk_precmd ${precmd_functions:#_agent_desk_precmd})
