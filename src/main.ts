import './style.css';
import p5 from 'p5';
import { Game } from './Game';

const game = new Game();
new p5(game.sketch);
