'use strict';
/* The clubs and countries that are on the wheel by default. Names only: there is no player data,
   whoever lands on a team types the name of the player they pick. */
const all = {
  clubs: ['Real Madrid', 'Barcelona', 'Man City', 'Liverpool', 'Arsenal', 'Bayern', 'PSG', 'Inter', 'Juventus', 'Chelsea', 'Man United', 'Atlético', 'AC Milan', 'Dortmund'],
  nations: ['Brazil', 'Argentina', 'France', 'England', 'Spain', 'Portugal', 'Germany', 'Netherlands', 'Italy', 'Belgium', 'Croatia', 'Morocco'],
};

module.exports = { all, getAll: () => all };
