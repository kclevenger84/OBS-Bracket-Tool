BRACKET TOOL - SETUP AND USE
===============================

One tool for showing a tournament bracket in OBS, controlled from a dock
inside OBS. The bracket can come from two places, picked at the top of the
dock:

  Manual bracket        You type the teams and click the scores yourself.
                        Any number of teams from 2 to 32. Single
                        elimination, single elimination with a 3rd place
                        match, or double elimination. Team logos.

  start.gg / Challonge  You paste the bracket link. Players, scores and who
                        advanced fill in by themselves and are checked every
                        10 seconds. Any size of single or double elimination
                        bracket. No account or API key needed.

It has two safety nets:

  - If start.gg or Challonge is wrong or behind, any match can be
    overridden by hand in the dock.
  - If this tool isn't running, the overlay shows the EsportsDash app's own
    bracket instead of an empty screen.

The EsportsDash dashboard still runs everything else (scoreboard, heroes,
maps, colors, logos).

WHAT'S NEW IN v2
----------------
Manual brackets are no longer limited to 4 or 8 teams. You enter the number
of teams, pick the bracket type and enter the teams in seed order; the
bracket is drawn from that. Everything else (start.gg / Challonge links,
slots, rotation, overrides, the safety net) is the same as "Bracket Tool".

v2 is completely separate from the "Bracket Tool" folder. It uses its own
port (8094 instead of 8093), its own overlay page (bracket-tool-v2.html)
and its own saved data, so both can be installed on the same computer. The
older "Bracket Controller" folders and "StartGG Bracket" are not changed
either.


WHAT'S IN THIS FOLDER
---------------------
  Start Bracket Tool v2.bat       Double-click to start the tool.
  bracket-tool-v2-server.js    The program (don't edit).
  dock.html                    The panel shown in the OBS dock.
  overlay\bracket-tool-v2.html    The bracket overlay page. It gets copied into
                               the EsportsDash app (Setup step 4).
  overlay\fonts\               The font the overlay uses.
  logos\                       Team logos for manual brackets. Uploads land
                               here, and you can drop image files in here
                               yourself.
  data\bracket-tool.json       Your teams, scores, link and settings (saved
                               automatically). Delete it to start fresh.


SETUP ON A NEW COMPUTER (one time)
----------------------------------
Do these steps in order. Step 4 needs the folder that step 1 creates.

1. Install OBS and the EsportsDash app. In the app, install the overlay pack
   and set up the OBS scenes, the same as usual.

2. Install Node.js (skip if a Bracket Controller already works here):
     - Go to https://nodejs.org
     - Download the "LTS" version and install it with the default options.

3. Copy this whole "Bracket Tool v2" folder to the computer. Anywhere is fine,
   for example the Desktop.

4. Copy the overlay page into the EsportsDash app:
     a. Open File Explorer, click in the address bar, paste this and press
        Enter:
          %APPDATA%\esportsdashboard\uploads\overlays\esportsdash.default\html
     b. Copy overlay\bracket-tool-v2.html from this folder into that folder.
        (Don't replace or delete anything that is already there.)

   This is what makes the safety net work: the page lives in the app, so it
   still loads when this tool is closed.

5. In OBS, add the dock:
     - Top menu: Docks -> Custom Browser Docks...
     - Dock Name: Bracket Tool v2
     - URL:       http://127.0.0.1:8094/
     - Click Apply, then Close. Drag the dock wherever you want it.

6. In OBS, point the "HTML Bracket" browser source at the new page
   (right-click it -> Properties):
     - Local file:  UNCHECKED
     - URL:         http://localhost:8081/overlays/esportsdash.default/html/bracket-tool-v2.html
                    (make sure it starts with http:// - two slashes)
     - Width:       1920
     - Height:      1080
     - Click "Refresh cache of current page", then OK.

   To go back to an older bracket page, change the end of the URL to
   bracket-tool.html, bracket-controller-v2.html, bracket-controller.html
   or bracket.html.

Moving over from Bracket Tool or Bracket Controller v2: teams and scores
are not carried over. Copy your logo files from the old "logos" folder into
this "logos" folder and enter the teams again on the Teams tab, in seed
order (see Manual bracket below - the order means something different now).


EVERY STREAM
------------
1. Start the EsportsDash app.
2. Double-click "Start Bracket Tool v2.bat". Leave the black window open while
   streaming. Closing it stops the tool.
3. Open OBS.

If the dock says "Server not running", do step 2. The dock reconnects by
itself within a few seconds.

Everything is remembered between streams: the source you picked, the manual
teams and scores, and the last bracket link.


PICKING WHERE THE BRACKET COMES FROM
------------------------------------
The two buttons at the top of the dock switch the overlay between "Manual
bracket" and "start.gg / Challonge". The green one is what the overlay is
showing. Switching doesn't lose anything: the manual bracket and the link
are both kept.


MANUAL BRACKET
--------------
Settings tab (start here for a new event)
  - Number of teams: anything from 2 to 32. Type it and press Enter.
  - Bracket type:
      Single elimination              Lose once and you're out.
      Single elimination + 3rd place  The same, plus a 3rd place match
                                      between the semifinal losers (needs
                                      at least 4 teams).
      Double elimination              Upper and lower bracket, grand final
                                      with a reset match if needed.
    Changing the number of teams or the type sets every score back to 0-0.
    Team names and logos stay.
  - Title shown on the overlay (default "Playoffs").
  - Match length: best of 1 / 3 / 5 / 7 for each stage of the bracket.
    (Bo3 = first to 2 wins, Bo5 = first to 3, Bo7 = first to 4.)
      Single elimination: Early rounds, Semifinals, Grand Final, 3rd Place.
      Double elimination: Upper Bracket, Upper Final, Lower Bracket,
                          Lower Final, Grand Final.
    Only the stages your bracket has are shown.
  - "Reset all scores" keeps the teams and sets every score to 0-0.
  - "Clear teams & scores" empties everything for a new event.

Teams tab
  - Enter the teams in SEED order: seed 1 is the best team, seed 2 the
    second best, and so on. You do not work out the pairings yourself.
  - The tool places the seeds so the best teams can only meet late:
      4 teams:   1 v 4,  2 v 3
      8 teams:   1 v 8,  4 v 5,  2 v 7,  3 v 6
      16 teams:  1 v 16, 8 v 9,  4 v 13, 5 v 12,
                 2 v 15, 7 v 10, 3 v 14, 6 v 11
    Seeds 1 and 2 are on opposite sides and can only meet in the final.
  - Byes: if the number of teams isn't 2, 4, 8, 16 or 32, the top seeds
    skip the first round. With 6 teams, seeds 1 and 2 start in the
    semifinals; 3 v 6 and 4 v 5 play first. With 5 teams, only 4 v 5 plays
    in the first round.
  - Under each team you can see the match it starts in, and "(bye before
    it)" if it skips a round.
  - Pick a logo from the list, or click Upload to add one.

  This is different from Bracket Tool and Bracket Controller v2, where
  teams 1 & 2 played each other in the first round.

Matches tab
  - Use + and - to change scores.
  - When a team reaches the wins needed, they move on automatically.
  - Made a mistake? Click - to fix it. If a different team ends up
    advancing, later matches that changed go back to 0-0.
  - Fixing a typo in a team name never resets any scores.

How double elimination works
  - Everyone starts in the Upper Bracket. Losing an upper bracket match
    drops you to the Lower Bracket. Losing a lower bracket match knocks
    you out.
  - Teams dropping out of the upper bracket are placed in the lower bracket
    in a mixed-up order, so in the early rounds nobody is sent straight
    back against the team they just played.
  - The Upper Final winner plays the Lower Final winner in the Grand Final.
  - If the Upper Bracket team wins the Grand Final, they're champions.
  - If the Lower Bracket team wins, both teams now have one loss, so the
    Grand Final Reset is played to decide the champion. The reset match
    only fills in when it's needed. Otherwise it's hidden on the overlay.
  - The Lower Final loser finishes 3rd.

On the overlay
  - A match that has a score entered but no winner yet is marked LIVE.


HOW THE BRACKET LOOKS (ALL SOURCES)
-----------------------------------
  - One column per round, first round on the left, final on the right,
    with the round name above each column.
  - Each match is a card with two team rows: name on the left, score on
    the right. All cards are the same size.
  - Each match sits half way between the two matches that feed it, and
    lines show where the winner goes, so the spacing grows each round.
  - Byes: a team that skips the first round is drawn where it would have
    been if that match existed. With 7 teams, seed 1's semifinal sits
    above the 4 v 5 match and the line steps up into it.
  - Double elimination: upper bracket on top, lower bracket underneath,
    grand final on the right between the two.
  - The winner's row is highlighted. A match being played has a red frame
    and a LIVE tag. Teams that aren't decided yet show TBD.
  - The 3rd place match and the grand final reset sit under the final with
    their own name.
  - Everything is sized to fit the screen below the title: small brackets
    get large cards, big ones shrink. Long names are cut off with "...".
  - The background is transparent, so it sits over the stream.

START.GG / CHALLONGE
--------------------
Bracket tab

  Bracket slot (several brackets at the same time)
    Each slot holds one linked bracket with its own link, settings and
    overrides. Up to 12 slots. Every loaded slot is checked every 10
    seconds, whether or not it is on screen.

    - "+ Add" makes a new empty slot. Paste a link into it and click Load.
    - The list switches between slots. The slot you have open is the one
      the main overlay shows.
    - "Remove" deletes the open slot. Slot numbers never change: removing
      slot 2 leaves slots 1 and 3.

    One OBS source per bracket
      Add ?slot=NUMBER to the end of the overlay URL to make a source that
      always shows that slot, whatever the dock is set to. For slot 2:
        http://localhost:8081/overlays/esportsdash.default/html/bracket-tool-v2.html?slot=2
      Make one browser source (or scene) per bracket and cut between them
      in OBS. These sources keep working while the main overlay shows the
      manual bracket.

    Rotation (bottom of the Bracket tab)
      Tick "Rotate through the brackets instead of showing one" and the
      main overlay shows each loaded slot in turn. Pick the seconds per
      bracket. Untick "Include this bracket in the rotation" on a slot to
      leave it out. Sources with ?slot=NUMBER never rotate.

  Bracket link
    Open the bracket on the site and copy the link from the browser's
    address bar, paste it in and click Load.
      start.gg:   https://www.start.gg/tournament/NAME/event/EVENT/brackets/123/456
      Challonge:  https://challonge.com/9kfga8t4
    A start.gg link to just the event or the tournament also works. If it
    has more than one bracket, a "Which bracket?" list appears.
    A Challonge bracket has to be public. It can be loaded before the
    tournament is started.

  Status box
    Shows the event name, how many matches are finished and when the site
    was last checked. A green bar means it's working. A red bar shows what
    went wrong (for example no internet). The overlay keeps showing the
    last data it received until the connection comes back.

  Title on the overlay
    Leave it blank to use the tournament name from the site.

  Rounds to show
    Auto            Shows the top 8. While the top 8 hasn't started yet it
                    shows the top 16 (or top 32) instead. It switches by
                    itself as the event moves on.
    Top 4 / 8 / 16 / 32
                    Always show that part of the bracket.
    Whole bracket   Everything, finished matches included. Big brackets
                    shrink to fit, so the text gets small. For very big
                    brackets use "Side" to show half at a time.

  Side
    Winners + losers, winners only, or losers only. The grand final is
    always shown.

  Show team / sponsor tags in names (start.gg only)
    On:  "LSW | CupcakeMK"     Off: "CupcakeMK"

  Clear bracket
    Empties the overlay.

Matches tab (overriding by hand)
  Lists every match of the loaded bracket as the site reports it.

  - Click "Override" on a match, type the two names and scores, pick who
    won (or "No winner yet") and click "Save override".
  - An overridden match gets an orange border and "Overridden". It ignores
    the site until you remove the override. Every other match keeps
    updating.
  - "Edit" changes an override. "Remove override" goes back to what the
    site says. "Clear all overrides" removes all of them.
  - An override does NOT move the winner into the next match. The site
    decides who is in later matches, so override the next match too if it
    is also wrong.
  - Scores can be a number or short text such as DQ or W.
  - Overrides are dropped when you load a different bracket.
  - If the site can't be reached, the overlay keeps the last data and you
    can still override on top of it.

What the overlay shows for a linked bracket
  - The winner of each finished match is highlighted.
  - Scores are the game counts reported on the site. If only a winner was
    reported, it shows W and L. A disqualification shows DQ.
  - A match in progress has a red frame and a LIVE tag.
  - Spots that aren't decided yet show TBD. Byes are left out.
  - The Grand Final Reset disappears if the winners bracket player wins the
    first grand final.
  - No logos: the sites don't provide them.


THE SAFETY NET (TOOL NOT RUNNING)
---------------------------------
If the Bracket Tool isn't running (not started, or its window got closed),
the overlay shows the EsportsDash app's own bracket within a few seconds:
8 teams, single elimination, with the 3rd place match filled from the
semifinal losers. When the tool is started again the overlay switches back
by itself.

  - This only helps if the bracket page in the EsportsDash app has your
    teams in it. If it's empty, viewers see an empty 8 team bracket.
  - The app's bracket counts a match as won at 2 wins (best of 3). For
    best of 5 add ?wins=3 to the end of the OBS source URL, for best of 7
    add ?wins=4.
  - It needs setup steps 4 and 6 (the page copied into the app, and OBS
    pointed at it there).
  - The app only has one bracket, so every overlay source shows the same
    one while the tool is down, including sources with ?slot=NUMBER.


TROUBLESHOOTING
---------------
Overlay shows the wrong bracket (8 teams you didn't enter)
  - That's the safety net: the tool isn't running. Start it (Every stream,
    step 2).

Overlay is empty
  - Check the dock: is the right source green at the top? For a link, is a
    bracket loaded with a green bar?
  - Make sure the OBS source URL ends in bracket-tool-v2.html (step 6) and
    that bracket-tool-v2.html is in the app's html folder (step 4). If
    EsportsDash reinstalls its overlay pack it may remove it. Just do step
    4 again.
  - In OBS, open the HTML Bracket source properties and click "Refresh
    cache of current page".

"That link isn't a single or double elimination bracket"
  - Pools, swiss and round robin can't be shown as a bracket. Use the link
    of the elimination bracket.

A linked match looks wrong or is behind
  - The overlay shows what's entered on the site, up to about 10 seconds
    late. If the site itself is wrong, override the match on the Matches
    tab.

Black window says "Port 8094 is already in use"
  - The tool is already running in another window. Use that one, or close
    it and start again.

Black window says "Node.js is not installed"
  - Do setup step 2, then start it again.

Colors / logo at the bottom of the overlay are missing
  - Those come from the EsportsDash app. Make sure it's running. Without it
    the overlay uses black and green.
