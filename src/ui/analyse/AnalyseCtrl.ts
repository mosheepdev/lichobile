import * as debounce from 'lodash/debounce'
import router from '../../router'
import Chessground from '../../chessground/Chessground'
import * as cg from '../../chessground/interfaces'
import * as chess from '../../chess'
import * as chessFormat from '../../utils/chessFormat'
import { build as makeTree, path as treePath, ops as treeOps, TreeWrapper, Tree } from '../shared/tree'
import redraw from '../../utils/redraw'
import session from '../../session'
import sound from '../../sound'
import socket from '../../socket'
import { openingSensibleVariants } from '../../lichess/variant'
import * as gameApi from '../../lichess/game'
import { AnalyseData, AnalyseDataWithTree, isOnlineAnalyseData } from '../../lichess/interfaces/analyse'
import { Opening } from '../../lichess/interfaces/game'
import settings from '../../settings'
import { oppositeColor, hasNetwork, noop } from '../../utils'
import promotion from '../shared/offlineRound/promotion'
import continuePopup, { Controller as ContinuePopupController } from '../shared/continuePopup'
import { NotesCtrl } from '../shared/round/notes'
import * as util from './util'
import CevalCtrl from './ceval/CevalCtrl'
import { ICevalCtrl, Work as CevalWork } from './ceval/interfaces'
import crazyValid from './crazy/crazyValid'
import ExplorerCtrl from './explorer/ExplorerCtrl'
import { IExplorerCtrl } from './explorer/interfaces'
import menu, { IMainMenuCtrl } from './menu'
import analyseSettings, { ISettingsCtrl } from './analyseSettings'
import ground from './ground'
import socketHandler from './analyseSocketHandler'
import { Source } from './interfaces'
import * as tabs from './tabs'

export default class AnalyseCtrl {
  data: AnalyseData
  orientation: Color
  source: Source

  settings: ISettingsCtrl
  menu: IMainMenuCtrl
  continuePopup: ContinuePopupController
  notes: NotesCtrl | null
  chessground: Chessground
  ceval: ICevalCtrl
  explorer: IExplorerCtrl
  tree: TreeWrapper

  // current tree state, cursor, and denormalized node lists
  path: Tree.Path
  node: Tree.Node
  nodeList: Tree.Node[]
  mainline: Tree.Node[]

  // state flags
  onMainline: boolean = true
  synthetic: boolean // false if coming from a real game
  ongoing: boolean // true if real game is ongoing

  // paths
  initialPath: Tree.Path
  gamePath?: Tree.Path
  contextMenu: Tree.Path | null = null

  // various view state flags
  replaying: boolean = false
  cgConfig?: cg.SetConfig
  shouldGoBack: boolean
  analysisProgress: boolean = false
  formattedDate: string

  private _currentTabIndex: number = 0

  private debouncedExplorerSetStep: () => void

  public static decomposeUci(uci: string): [Key, Key, SanChar] {
    return [<Key>uci.slice(0, 2), <Key>uci.slice(2, 4), <SanChar>uci.slice(4, 5)]
  }

  constructor(
    data: AnalyseData,
    source: Source,
    orientation: Color,
    shouldGoBack: boolean,
    ply?: number,
    tab?: number
  ) {
    this.data = data
    this.orientation = orientation
    this.source = source
    this.synthetic = util.isSynthetic(data)
    this.initialPath = treePath.root
    this._currentTabIndex = tab !== undefined ? tab :
      this.synthetic ? 0 : 1

    if (settings.analyse.supportedVariants.indexOf(this.data.game.variant.key) === -1) {
      window.plugins.toast.show(`Analysis board does not support ${this.data.game.variant.name} variant.`, 'short', 'center')
      router.set('/')
    }

    this.tree = makeTree(treeOps.reconstruct(this.data.treeParts))

    this.settings = analyseSettings.controller(this)
    this.menu = menu.controller(this)
    this.continuePopup = continuePopup.controller()

    // TODO
    // this.notes = session.isConnected() && this.data.game.speed === 'correspondence' ? new NotesCtrl(this.data) : null
    this.notes = null

    this.ceval = CevalCtrl(
      this.data.game.variant.key,
      this.allowCeval(),
      this.onCevalMsg,
      {
        multiPv: this.settings.s.cevalMultiPvs,
        cores: this.settings.s.cevalCores,
        infinite: this.settings.s.cevalInfinite
      }
    )

    this.explorer = ExplorerCtrl(this)
    this.debouncedExplorerSetStep = debounce(this.explorer.setStep, this.data.pref.animationDuration + 50)

    const initPly = Number(ply) ||
      (location.hash && parseInt(location.hash.replace(/#/, ''), 10)) ||
      (this.source === 'online' && gameApi.isPlayerPlaying(this.data) ?
        this.tree.lastPly() : this.tree.firstPly())

    this.gamePath = (this.synthetic || this.ongoing) ? undefined :
      treePath.fromNodeList(treeOps.mainlineNodeList(this.tree.root))

    const mainline = treeOps.mainlineNodeList(this.tree.root)
    this.initialPath = treeOps.takePathWhile(mainline, n => n.ply <= initPly)
    this.setPath(this.initialPath)

    const gameMoment = window.moment(this.data.game.createdAt)

    this.shouldGoBack = shouldGoBack
    this.formattedDate = gameMoment.format('L LT')

    if (
      !this.data.analysis && session.isConnected() &&
      isOnlineAnalyseData(this.data) && gameApi.analysable(this.data)
    ) {
      this.connectGameSocket()
    } else {
      socket.createDefault()
    }

    this.showGround()

    if (this.currentTab(this.availableTabs()).id === 'explorer') {
      this.debouncedExplorerSetStep()
    }

    setTimeout(this.debouncedScroll, 250)
    setTimeout(this.initCeval, 1000)
    window.plugins.insomnia.keepAwake()
    document.addEventListener('pause', this.onPause)
    document.addEventListener('resume', this.onResume)
    window.addEventListener('unload', this.onUnload)
  }

  canDrop = () => {
    return true
  }

  player = () => {
    return this.data.game.player
  }

  bottomColor(): Color {
    return this.settings.s.flip ? oppositeColor(this.data.orientation) : this.data.orientation
  }

  connectGameSocket = () => {
    if (hasNetwork() &&
      this.data.url !== undefined &&
      this.data.player.version !== undefined
    ) {
      socket.createGame(
        this.data.url.socket,
        this.data.player.version,
        socketHandler(this),
        this.data.url.round
      )
    }
  }

  availableTabs = (): tabs.Tab[] => {
    let val = tabs.defaults

    if (this.synthetic) val = val.filter(t => t.id !== 'infos')
    if (this.ceval.enabled()) val = val.concat([tabs.ceval])
    if (isOnlineAnalyseData(this.data) && gameApi.analysable(this.data)) {
      val = val.concat([tabs.charts])
    }
    if (hasNetwork()) val = val.concat([tabs.explorer])

    return val
  }

  currentTabIndex = (avail: tabs.Tab[]): number => {
    if (this._currentTabIndex > avail.length - 1) return avail.length - 1
    else return this._currentTabIndex
  }

  currentTab = (avail: tabs.Tab[]): tabs.Tab => {
    return avail[this.currentTabIndex(avail)]
  }

  onTabChange = (index: number) => {
    const loc = window.location.search.replace(/\?tab\=\w+$/, '')
    try {
      window.history.replaceState(window.history.state, '', loc + '?tab=' + index)
    } catch (e) {
      console.error(e)
    }
    this._currentTabIndex = index
    const cur = this.currentTab(this.availableTabs())
    if (cur.id === 'moves') this.debouncedScroll()
    else if (cur.id === 'explorer') this.explorer.setStep()
    redraw()
  }

  // call this when removing a tab, to avoid a lazy tab loading indefinitely
  resetTabs = () => this.onTabChange(this.currentTabIndex(this.availableTabs()))

  setPath = (path: Tree.Path): void => {
    this.path = path
    this.nodeList = this.tree.getNodeList(path)
    this.node = treeOps.last(this.nodeList) as Tree.Node
    this.mainline = treeOps.mainlineNodeList(this.tree.root)
    this.onMainline = this.tree.pathIsMainline(path)
  }

  promote(path: Tree.Path, toMainline: boolean): void {
    this.tree.promoteAt(path, toMainline)
    this.contextMenu = null
    this.jump(path)
  }

  deleteNode(path: Tree.Path): void {
    const node = this.tree.nodeAtPath(path)
    if (!node) return
    const count = treeOps.countChildrenAndComments(node)
    if (count.nodes >= 10 || count.comments > 0) {
      navigator.notification.confirm(
        `Delete ${count.nodes} move(s)` + (count.comments ? ` and ${count.comments} comment(s)` : '') + '?',
        () => this._deleteNode(path)
      )
    } else {
      this._deleteNode(path)
    }
  }

  initCeval = () => {
    if (this.ceval.enabled()) {
      if (this.ceval.isInit()) {
        this.startCeval()
      } else {
        this.ceval.init().then(this.startCeval)
      }
    }
  }

  debouncedScroll = debounce(() => util.autoScroll(document.getElementById('replay')), 200)

  jump = (path: Tree.Path, direction?: 'forward' | 'backward') => {
    this.setPath(path)
    // this.toggleVariationMenu()
    this.showGround()
    this.fetchOpening()
    if (this.node && this.node.san && direction === 'forward') {
      if (this.node.san.indexOf('x') !== -1) sound.throttledCapture()
      else sound.throttledMove()
    }
    this.ceval.stop()
    this.debouncedExplorerSetStep()
    this.updateHref()
    this.startCeval()
    promotion.cancel(this.chessground, this.cgConfig)
  }

  userJump = (path: Tree.Path, direction?: 'forward' | 'backward') => {
    this.jump(path, direction)
  }

  jumpToMain = (ply: number) => {
    this.userJump(this.mainlinePathToPly(ply))
  }

  jumpToIndex = (index: number) => {
    this.jumpToMain(index + 1 + (this.data.game.startedAtTurn || 0))
  }

  fastforward = () => {
    this.replaying = true
    const more = this.next()
    if (!more) {
      this.replaying = false
      this.debouncedScroll()
    }
    return more
  }

  stopff = () => {
    this.replaying = false
    this.next()
    this.debouncedScroll()
  }

  rewind = () => {
    this.replaying = true
    const more = this.prev()
    if (!more) {
      this.replaying = false
      this.debouncedScroll()
    }
    return more
  }

  stoprewind = () => {
    this.replaying = false
    this.prev()
    this.debouncedScroll()
  }

  explorerMove = (uci: string) => {
    const move = AnalyseCtrl.decomposeUci(uci)
    if (uci[1] === '@') {
      this.chessground.apiNewPiece({
        color: this.chessground.state.movable.color as Color,
        role: util.sanToRole[uci[0]]
      }, move[1])
    } else if (!move[2]) {
      this.sendMove(move[0], move[1])
    }
    else {
      this.sendMove(move[0], move[1], util.sanToRole[move[2].toUpperCase()])
    }
    this.explorer.loading(true)
  }

  mergeAnalysisData(data: AnalyseDataWithTree): void {
    this.tree.merge(data.tree)
    this.data.analysis = data.analysis
    redraw()
  }

  gameOver() {
    if (!this.node) return false
    // step.end boolean is fetched async for online games (along with the dests)
    if (this.node.end === undefined) {
      if (this.node.check) {
        const san = this.node.san
        const checkmate = san && san[san.length - 1] === '#'
        return checkmate
      }
    } else {
      return this.node.end
    }
  }

  canUseCeval = () => {
    return !this.gameOver()
  }

  nextNodeBest() {
    return treeOps.withMainlineChild(this.node, (n: Tree.Node) => n.eval ? n.eval.best : undefined)
  }

  hasAnyComputerAnalysis = () => {
    return this.data.analysis || this.ceval.enabled()
  }

  unload = () => {
    if (this.ceval) this.ceval.destroy()
    document.removeEventListener('pause', this.onPause)
    document.removeEventListener('resume', this.onResume)
  }

  // ---

  private _deleteNode = (path: Tree.Path) => {
    this.tree.deleteNodeAt(path)
    this.contextMenu = null
    if (treePath.contains(this.path, path)) this.userJump(treePath.init(path))
    else this.jump(this.path)
  }

  private updateHref = debounce(() => {
    const step = this.node
    if (step) {
      try {
        window.history.replaceState(window.history.state, '', '#' + step.ply)
      } catch (e) { console.error(e) }
    }
  }, 750)

  private mainlinePathToPly(ply: Ply): Tree.Path {
    return treeOps.takePathWhile(this.mainline, n => n.ply <= ply)
  }

  private canGoForward() {
    return this.node.children.length > 0
  }

  private next() {
    if (!this.canGoForward()) return false

    const child = this.node.children[0]
    if (child) this.userJump(this.path + child.id, 'forward')

    return true
  }

  private prev() {
    this.userJump(treePath.init(this.path), 'backward')

    return true
  }

  private sendMove = (orig: Key, dest: Key, prom?: Role) => {
    const move: chess.MoveRequest = {
      orig,
      dest,
      variant: this.data.game.variant.key,
      fen: this.node.fen,
      path: this.path
    }
    if (prom) move.promotion = prom
    chess.move(move)
    .then(this.addNode)
    .catch(err => console.error('send move error', move, err))
  }

  private userMove = (orig: Key, dest: Key, captured?: Piece) => {
    if (captured) sound.capture()
    else sound.move()
    if (!promotion.start(this.chessground, orig, dest, this.sendMove)) this.sendMove(orig, dest)
  }

  private userNewPiece = (piece: Piece, pos: Key) => {
    if (crazyValid.drop(piece.role, pos, this.node.drops)) {
      sound.move()
      const drop = {
        role: piece.role,
        pos,
        variant: this.data.game.variant.key,
        fen: this.node.fen,
        path: this.path
      }
      chess.drop(drop)
      .then(this.addNode)
      .catch(err => {
        // catching false drops here
        console.error('wrong drop', err)
        this.jump(this.path)
      })
    } else this.jump(this.path)
  }

  private addNode = ({ situation, path }: chess.MoveResponse) => {
    const curNode = this.node
    const node = {
      id: situation.nodeId,
      ply: situation.ply,
      fen: situation.fen,
      uci: situation.uciMoves[0],
      children: [],
      dests: situation.dests,
      drops: situation.drops,
      check: situation.check,
      end: situation.end,
      player: situation.player,
      checkCount: situation.checkCount,
      san: situation.pgnMoves[0],
      crazyhouse: situation.crazyhouse,
      pgnMoves: curNode && curNode.pgnMoves ? curNode.pgnMoves.concat(situation.pgnMoves) : undefined
    }
    if (path === undefined) {
      console.error('Cannot addNode, missing path', node)
      return
    }
    const newPath = this.tree.addNode(node, path)
    if (!newPath) {
      console.error('Cannot addNode', node, path)
      return
    }
    this.jump(newPath)
    this.debouncedScroll()
    redraw()
  }

  private allowCeval() {
    return (
      this.source === 'offline' || util.isSynthetic(this.data) || !gameApi.playable(this.data)
    ) &&
      gameApi.analysableVariants
      .indexOf(this.data.game.variant.key) !== -1
  }

  private onCevalMsg = (work: CevalWork, ceval?: Tree.ClientEval) => {
    if (ceval) {
      this.tree.updateAt(work.path, (node: Tree.Node) => {
        if (node.ceval && node.ceval.depth >= ceval.depth) return

        if (node.ceval === undefined) {
          node.ceval = <Tree.ClientEval>Object.assign({}, ceval)
        }
        else {
          node.ceval = <Tree.ClientEval>Object.assign(node.ceval, ceval)
        }

        if (node.ceval.pvs.length > 0) {
          node.ceval.best = node.ceval.pvs[0].moves[0]
        }

        if (work.path === this.path) {
          redraw()
        }
      })
    }
    // no ceval means stockfish has finished, just redraw
    else {
      if (this.currentTab(this.availableTabs()).id === 'ceval') redraw()
    }
  }

  private startCeval = debounce(() => {
    if (this.ceval.enabled() && this.canUseCeval()) {
      this.ceval.start(this.path, this.nodeList)
    }
  }, 800)

  private showGround() {
    const node = this.node

    if (this.data.game.variant.key === 'threeCheck' && !node.checkCount) {
      node.checkCount = util.readCheckCount(node.fen)
    }

    const color: Color = node.ply % 2 === 0 ? 'white' : 'black'
    const dests = util.readDests(node.dests)
    const config = {
      fen: node.fen,
      turnColor: color,
      orientation: this.settings.s.flip ? oppositeColor(this.orientation) : this.orientation,
      movableColor: this.gameOver() ? null : color,
      dests: dests || null,
      check: !!node.check,
      lastMove: node.uci ? chessFormat.uciToMoveOrDrop(node.uci) : null
    }

    this.cgConfig = config
    this.data.game.player = color
    if (!this.chessground) {
      this.chessground = ground.make(this.data, config, this.orientation, this.userMove, this.userNewPiece)
    } else {
      this.chessground.set(config)
    }

    if (!dests) this.getNodeSituation()
  }

  private getNodeSituation = debounce(() => {
    if (this.node && !this.node.dests) {
      chess.situation({
        variant: this.data.game.variant.key,
        fen: this.node.fen,
        path: this.path
      })
      .then(({ situation, path }) => {
        this.tree.updateAt(path, (node: Tree.Node) => {
          node.dests = situation.dests
          node.end = situation.end
          node.player = situation.player
        })
        if (path === this.path) {
          this.showGround()
          redraw()
          if (this.gameOver()) this.ceval.stop()
        }
      })
      .catch(err => console.error('get dests error', err))
    }
  }, 50)

  private fetchOpening = debounce(() => {
    if (
      hasNetwork() && this.node && this.node.opening === undefined &&
      this.node.ply <= 20 && this.node.ply > 0 &&
      openingSensibleVariants.has(this.data.game.variant.key)
    ) {
      let msg: { fen: string, path: string, variant?: VariantKey } = {
        fen: this.node.fen,
        path: this.path
      }
      const variant = this.data.game.variant.key
      if (variant !== 'standard') msg.variant = variant
      this.tree.updateAt(this.path, (node: Tree.Node) => {
        // flag opening as null in any case to not request twice
        node.opening = null
        socket.ask('opening', 'opening', msg)
        .then((d: { opening: Opening, path: string }) => {
          if (d.opening && d.path) {
            node.opening = d.opening
            if (d.path === this.path) redraw()
          }
        })
        .catch(noop)
      })
    }
  }, 50)

  private onPause = () => {
    if (this.ceval.isSearching() && this.ceval.opts.infinite) {
      window.cordova.plugins.notification.local.schedule({
        title: 'Stockfish engine is running.',
        text: 'It will stop after 10 minutes of inactivity.',
        at: new Date(Date.now() + 1000 * 30),
        icon: 'res://mipmap/icon',
        smallIcon: 'res://drawable/ic_stat_onesignal_default'
      })
    }
  }

  private onResume = () => {
    window.cordova.plugins.notification.local.cancelAll()
  }

  private onUnload = () => {
    // no better way to not trigger notif when killing app?
    window.cordova.plugins.notification.local.cancelAll()
  }
}
