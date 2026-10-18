# Relay shell integration. zsh starts here because Relay points ZDOTDIR at this folder.
# Load your own .zshenv first, then come back here so our .zshrc runs next.
_agent_desk_dir=$ZDOTDIR
ZDOTDIR=${AGENT_DESK_USER_ZDOTDIR:-$HOME}
[[ -f $ZDOTDIR/.zshenv ]] && source $ZDOTDIR/.zshenv
_agent_desk_user_zdotdir=$ZDOTDIR
ZDOTDIR=$_agent_desk_dir
