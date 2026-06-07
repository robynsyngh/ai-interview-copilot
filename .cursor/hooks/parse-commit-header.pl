#!/usr/bin/env perl
# Extract the commit subject (first real line) from a `git commit` shell command.
# Reads the command from the COMMITCMD env var. Prints the subject or nothing.
use strict;
use warnings;

my $c = $ENV{COMMITCMD} // '';
my $msg;

# heredoc form:  git commit -m "$(cat <<'EOF' ... EOF)"
if ($c =~ /<<-?\s*['"]?(\w+)['"]?\r?\n(.*?)\r?\n\s*\1\b/s) {
    $msg = $2;
}
# -m "subject"
elsif ($c =~ /-m\s+"((?:[^"\\]|\\.)*)"/s) {
    $msg = $1;
}
# -m 'subject'
elsif ($c =~ /-m\s+'([^']*)'/s) {
    $msg = $1;
}

if (defined $msg) {
    for my $line (split /\n/, $msg) {
        $line =~ s/^\s+//;
        next if $line eq '' || $line =~ /^#/;
        print $line;
        last;
    }
}
