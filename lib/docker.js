const Dockerode = require('dockerode')
const { name } = require('../package')
const path = require('path')
const simpleGit = require('simple-git')
const fs = require('fs')
const EventEmitter = require('events')
const recursive = require('recursive-readdir')
const stripAnsi = require('strip-ansi')
const rimraf = require('rimraf')
const dotenv = require('dotenv')
const ApiDelegate = require('./apiDelegate')

class Docker extends EventEmitter {
  constructor(commitId) {
    super()
    this.run = this.run.bind(this)
    this.createDir = this.createDir.bind(this)
    this.getFiles = this.getFiles.bind(this)
    this.prepareCreateImage = this.prepareCreateImage.bind(this)
    this.buildImage = this.buildImage.bind(this)
    this.createContainer = this.createContainer.bind(this)
    this.removeDir = this.removeDir.bind(this)
    this.getContainerStatus = this.getContainerStatus.bind(this)
    this.getPort = this.getPort.bind(this)
    this.getHost = this.getHost.bind(this)
    this.readOasisConfig = this.readOasisConfig.bind(this)
    const { owner, repo } = new ApiDelegate()

    this.commitId = commitId.substr(0, 7)
    this.repo = repo
    this.owner = owner
    this.docker = new Dockerode({
      socketPath: '/var/run/docker.sock'
    })
    this.dir = path.join(__dirname, '../repos', this.containerName)
    this.oasisConfig = []
  }
  removeDir() {
    return new Promise(resolve => {
      // rimraf(this.dir, err => err ? reject(err) : resolve())
      rimraf(this.dir, () => resolve())
    })
  }
  prepareCreateImage() {
    return this.getFiles().then(this.buildImage)
  }
  buildImage(files) {
    return new Promise((resolve, reject) => {
      this.docker.buildImage({
        context: this.dir,
        src: files
      }, {
        t: this.imageName
      }, (err, stream) => {
        if(err) reject(err)
        this.docker.modem.followProgress(stream, err => {
          if(err) reject(err)
          resolve()
        }, event => {
          const message = event.stream || event.status
          this.emit('progress', stripAnsi(message))
        })
      })
    })
  }
  createDir() {
    return new Promise(resolve => {
      fs.mkdir(this.dir, err => resolve(!!err))
    }).then(exist => {
      if(exist) return
      this.git = simpleGit(this.dir)
      return this.git.clone(
      `https://github.com/${this.owner}/${this.repo}.git`
    , '.')
    })
  }
  getFiles() {
    return new Promise((resolve, reject) => {
      recursive(this.dir, (err, files) => err ? reject(err) : resolve(files))
    }).then(files => files.map(file => file.replace(this.dir, '')))
  }
  async run() {
    return this.createDir(this.dir).then(() => {
      return new Promise((resolve, reject) => {
        this.git.checkout(this.commitId, err => {
          if(err) reject(err)
          resolve()
        })
      })
    })
    .then(this.readOasisConfig)
    .then(this.prepareCreateImage)
    .then(this.removeDir)
    .then(this.createContainer)
    .then(async container => {
      await container.start().catch(() => {})
      return container
    })
    .then(container => container.inspect())
  }
  getHost(inspect) {
    const port = this.getPort(inspect)
    const { IPAddress } = inspect.NetworkSettings.Networks.bridge
    return `http://${IPAddress}:${port}`
  }
  getPort(inspect) {
    const envString = inspect.Config.Env.join('\n')
    const envPort = dotenv.parse(envString).OASIS_PORT
    if(envPort) {
      return envPort
    } else {
      const { Ports } = inspect.NetworkSettings
      const port = Object.keys(Ports).map(p => parseInt(p))[0]
      // TODO: throw error if port is undefined
      return port
    }
  }
  async readOasisConfig() {
    this.oasisConfig = await new Promise((resolve) => {
      fs.readFile(path.join(this.dir, '.oasis.env'), 'utf8', (err, res) => {
        if(err || !res) return resolve([])
        resolve(res.split('\n'))
      })
    })
  }
  createContainer() {
    return this.docker.createContainer({
      Image: this.imageName,
      name: this.containerName,
      // PublishAllPorts: true
      Env: this.oasisConfig
    }).catch(err => {
      const [, id] = err.message.match(/by container (\w+)\./)
      return this.docker.getContainer(id)
    })
  }
  get container() {
    return this.docker.getContainer(this.containerName)
  }
  getContainerStatus() {
    return this.docker.getContainer(this.containerName)
      .inspect()
      .then(res => res.State.Status)
      .catch(() => false)
  }
  get containerName() {
    return `${name}_${this.owner}_${this.repo}_${this.commitId}`
  }
  get imageName() {
    return `${name}_${this.owner}_${this.repo}:${this.tag}`
  }
  get tag() {
    return this.commitId
  }
}

module.exports = Docker
